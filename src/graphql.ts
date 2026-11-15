import { b64decode, b64encode, globalId, VIEWER_LOGIN } from './util.ts';
import {
  createComment,
  createIssue,
  createPull,
  getRepo,
  listIssues,
  listPulls,
  mergePull,
  patchIssue,
  peelToCommit,
  pullFiles,
  pullMergeable,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { parseCommit } from './objects.ts';

// ---------------------------------------------------------------------------------------------
// Tokenizer + parser for the subset of GraphQL the harness uses.
// ---------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const len = source.length;
  while (i < len) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < len && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        const raw = end < 0 ? source.slice(i + 3) : source.slice(i + 3, end);
        tokens.push({ kind: 'string', value: raw });
        i = end < 0 ? len : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < len && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < len) {
          const esc = source[j + 1]!;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === '"' ? '"' : esc === '\\' ? '\\' : esc === '/' ? '/' : esc === 'u' && j + 5 < len ? String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16)) : esc;
          j += esc === 'u' ? 6 : 2;
          continue;
        }
        out += source[j]!;
        j += 1;
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (ch === '.' && source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      let isFloat = false;
      while (j < len && /[0-9]/.test(source[j]!)) j += 1;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < len && /[0-9]/.test(source[j]!)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < len && /[0-9]/.test(source[j]!)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < len && /[_A-Za-z0-9]/.test(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${ch} at ${i}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

export interface Selection {
  kind: 'field' | 'fragmentSpread' | 'inlineFragment';
  name?: string;
  alias?: string;
  args?: Array<{ name: string; value: ValueNode }>;
  typeCondition?: string;
  fragmentName?: string;
  selections?: Selection[];
}

export interface Operation {
  kind: 'query' | 'mutation';
  name?: string;
  variables: Record<string, { default?: ValueNode }>;
  selections: Selection[];
}

export interface Fragment {
  name: string;
  typeCondition: string;
  selections: Selection[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    return this.tokens[this.pos++]!;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${token.kind}`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected name, got ${token.kind}`);
    if (value !== undefined && token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
    return token.value;
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parseDocument(): { operations: Operation[]; fragments: Map<string, Fragment> } {
    const operations: Operation[] = [];
    const fragments = new Map<string, Fragment>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        const selections = this.parseSelectionSet();
        fragments.set(name, { name, typeCondition, selections });
        continue;
      }
      operations.push(this.parseOperation());
    }
    return { operations, fragments };
  }

  private parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    const token = this.peek();
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      kind = this.next().value as 'query' | 'mutation';
    }
    let name: string | undefined;
    const next = this.peek();
    if (next.kind === 'name') name = this.next().value;
    const variables: Operation['variables'] = {};
    if (this.skipPunct('(')) {
      while (!this.skipPunct(')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        this.parseType();
        if (this.skipPunct('=')) variables[varName] = { default: this.parseValue() };
        else variables[varName] = {};
      }
    }
    this.parseDirectives();
    const selections = this.parseSelectionSet();
    return { kind, name, variables, selections };
  }

  private parseType(): void {
    if (this.skipPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.skipPunct('!');
  }

  private parseDirectives(): void {
    while (this.skipPunct('@')) {
      this.expectName();
      if (this.skipPunct('(')) {
        while (!this.skipPunct(')')) {
          this.expectName();
          this.expectPunct(':');
          this.parseValue();
        }
      }
    }
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!this.skipPunct('}')) {
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): Selection {
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      this.next();
      const token = this.peek();
      if (token.kind === 'name' && token.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.parseDirectives();
        const selections = this.parseSelectionSet();
        return { kind: 'inlineFragment', typeCondition, selections };
      }
      if (token.kind === 'name') {
        const fragmentName = this.next().value;
        this.parseDirectives();
        return { kind: 'fragmentSpread', fragmentName };
      }
      this.parseDirectives();
      const selections = this.parseSelectionSet();
      return { kind: 'inlineFragment', selections };
    }
    let name = this.expectName();
    let alias: string | undefined;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.skipPunct('(')) {
      while (!this.skipPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
    }
    this.parseDirectives();
    let selections: Selection[] | undefined;
    if (this.peek().kind === 'punct' && this.peek().value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', name, alias, args, selections };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.skipPunct(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.skipPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.kind}`);
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function resolveArgs(selection: Selection, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of selection.args ?? []) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Type metadata for __type introspection
// ---------------------------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'search'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Issue: ['id', 'number', 'title', 'body', 'state', 'labels', 'comments', 'repository', 'author', 'createdAt', 'updatedAt', 'url'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'merged', 'mergeable', 'files', 'createdAt', 'updatedAt', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'description', 'owner', 'defaultBranchRef', 'issues', 'issue', 'pullRequests', 'pullRequest', 'labels', 'viewerPermission', 'hasIssuesEnabled', 'url', 'createdAt'],
  User: ['id', 'login', 'avatarUrl', 'url'],
  Label: ['id', 'name', 'color', 'description'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  Ref: ['name', 'target'],
  GitObject: ['oid'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changeType', 'status'],
};

const TYPE_KINDS: Record<string, string> = {
  Issue: 'OBJECT',
  PullRequest: 'OBJECT',
  Repository: 'OBJECT',
  Query: 'OBJECT',
  Mutation: 'OBJECT',
  User: 'OBJECT',
  Label: 'OBJECT',
  IssueComment: 'OBJECT',
  Ref: 'OBJECT',
  GitObject: 'OBJECT',
  SearchType: 'ENUM',
  IssueState: 'ENUM',
  PullRequestState: 'ENUM',
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE', 'LABEL', 'CODE', 'WIKI'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
};

// ---------------------------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------------------------

interface GqlObject {
  __type: string;
  [key: string]: unknown;
}

interface Executor {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
  fragments: Map<string, Fragment>;
}

function cursorFor(index: number): string {
  return b64encode(Buffer.from(`cursor:${index}`, 'utf8'));
}

function indexFromCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor === '') return -1;
  try {
    const decoded = b64decode(cursor).toString('utf8');
    const match = /^cursor:(\d+)$/.exec(decoded);
    return match === null ? -1 : Number.parseInt(match[1], 10);
  } catch {
    return -1;
  }
}

interface ConnectionItem {
  node: GqlObject;
}

function buildConnection(items: ConnectionItem[], args: Record<string, unknown>): Record<string, unknown> {
  const after = typeof args.after === 'string' ? args.after : undefined;
  const first = typeof args.first === 'number' ? args.first : undefined;
  const start = indexFromCursor(after) + 1;
  const end = first === undefined ? items.length : Math.min(items.length, start + first);
  const slice = items.slice(start, end);
  return {
    totalCount: items.length,
    edges: slice.map((item, i) => ({ cursor: cursorFor(start + i), node: item.node })),
    nodes: slice.map((item) => item.node),
    pageInfo: {
      hasNextPage: end < items.length,
      hasPreviousPage: start > 0,
      startCursor: slice.length > 0 ? cursorFor(start) : null,
      endCursor: slice.length > 0 ? cursorFor(end - 1) : null,
    },
  };
}

function issueObject(repo: Repo, issue: Issue): GqlObject {
  return {
    __type: 'Issue',
    __repo: repo,
    __issue: issue,
    id: globalId('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state.toUpperCase(),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullObject(repo: Repo, pull: Pull): GqlObject {
  return {
    __type: 'PullRequest',
    __repo: repo,
    __pull: pull,
    id: globalId('PullRequest', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state === 'open' ? 'OPEN' : pull.merged ? 'MERGED' : 'CLOSED',
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    merged: pull.merged,
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

function repoObject(repo: Repo): GqlObject {
  return {
    __type: 'Repository',
    __repo: repo,
    id: globalId('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    description: repo.description,
    url: `https://github.com/${repo.owner}/${repo.name}`,
    createdAt: repo.createdAt,
  };
}

function userObject(login: string): GqlObject {
  return {
    __type: 'User',
    id: globalId('User', login === VIEWER_LOGIN ? 1000 : 2000),
    login,
    avatarUrl: `https://github.com/${login}.png`,
    url: `https://github.com/${login}`,
  };
}

function findByGlobalId(store: Store, id: string): GqlObject | null {
  try {
    const decoded = b64decode(id).toString('utf8');
    const parts = decoded.split(':');
    const kind = parts[0]!;
    if (kind === 'Repository' && parts.length === 2) {
      const repoId = Number.parseInt(parts[1]!, 10);
      for (const repo of store.repos.values()) {
        if (repo.id === repoId) return repoObject(repo);
      }
      return null;
    }
    if ((kind === 'Issue' || kind === 'PullRequest') && parts.length === 3) {
      const repoId = Number.parseInt(parts[1]!, 10);
      const number = Number.parseInt(parts[2]!, 10);
      for (const repo of store.repos.values()) {
        if (repo.id !== repoId) continue;
        if (kind === 'Issue') {
          const issue = repo.issues.get(number);
          return issue === undefined ? null : issueObject(repo, issue);
        }
        const pull = repo.pulls.get(number);
        return pull === undefined ? null : pullObject(repo, pull);
      }
      return null;
    }
    if (kind === 'User') return userObject(VIEWER_LOGIN);
    return null;
  } catch {
    return null;
  }
}

function executeSelections(
  exec: Executor,
  object: GqlObject,
  selections: Selection[],
  out: Record<string, unknown>,
): void {
  for (const selection of selections) {
    if (selection.kind === 'fragmentSpread') {
      const fragment = exec.fragments.get(selection.fragmentName!);
      if (fragment !== undefined) executeSelections(exec, object, fragment.selections, out);
      continue;
    }
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition !== undefined && selection.typeCondition !== object.__type) continue;
      executeSelections(exec, object, selection.selections ?? [], out);
      continue;
    }
    const key = selection.alias ?? selection.name!;
    const args = resolveArgs(selection, exec.variables);
    const result = resolveField(exec, object, selection.name!, args, selection.selections);
    out[key] = result;
  }
}

function resolveField(
  exec: Executor,
  object: GqlObject,
  field: string,
  args: Record<string, unknown>,
  selections: Selection[] | undefined,
): unknown {
  const type = object.__type;
  if (field === '__typename') return type;

  if (type === 'Query') {
    if (field === 'viewer') {
      const user = userObject(VIEWER_LOGIN);
      return selectObject(exec, user, selections);
    }
    if (field === 'repository') {
      const repo = getRepo(exec.store, String(args.owner ?? ''), String(args.name ?? ''));
      if (repo === undefined) return null;
      return selectObject(exec, repoObject(repo), selections);
    }
    if (field === 'node') {
      const found = findByGlobalId(exec.store, String(args.id ?? ''));
      if (found === null) return null;
      return selectObject(exec, found, selections);
    }
    if (field === '__type') {
      const name = String(args.name ?? '');
      const kind = TYPE_KINDS[name];
      if (kind === undefined) return null;
      return selectObject(exec, {
        __type: '__Type',
        name,
        kind,
        fields: (TYPE_FIELDS[name] ?? []).map((f) => ({ __type: '__Field', name: f })),
        enumValues: (ENUM_VALUES[name] ?? []).map((v) => ({ __type: '__EnumValue', name: v })),
      }, selections);
    }
    if (field === '__schema') {
      return selectObject(exec, {
        __type: '__Schema',
        queryType: { __type: '__Type', name: 'Query' },
        mutationType: { __type: '__Type', name: 'Mutation' },
        types: Object.keys(TYPE_KINDS).map((name) => ({ __type: '__Type', name, kind: TYPE_KINDS[name] })),
      }, selections);
    }
    exec.errors.push({ message: `Cannot query field "${field}" on type "Query".` });
    return null;
  }

  if (type === 'Mutation') {
    return resolveMutation(exec, field, args, selections);
  }

  if (type === 'Repository') {
    const repo = object.__repo as Repo;
    if (field === 'issue') {
      const number = Number(args.number);
      const issue = repo.issues.get(number);
      if (issue === undefined) return null;
      return selectObject(exec, issueObject(repo, issue), selections);
    }
    if (field === 'pullRequest') {
      const number = Number(args.number);
      const pull = repo.pulls.get(number);
      if (pull === undefined) return null;
      return selectObject(exec, pullObject(repo, pull), selections);
    }
    if (field === 'viewerPermission') return 'ADMIN';
    if (field === 'hasIssuesEnabled') return true;
    if (field === 'issues') {
      const states = Array.isArray(args.states) ? (args.states as string[]) : undefined;
      const issues = listIssues(repo, {
        state: states === undefined ? 'all' : states.includes('OPEN') && states.includes('CLOSED') ? 'all' : states.includes('OPEN') ? 'open' : 'closed',
        sort: 'created',
        direction: 'desc',
      });
      const connection = buildConnection(issues.map((issue) => ({ node: issueObject(repo, issue) })), args);
      return selectConnection(exec, connection, selections);
    }
    if (field === 'pullRequests') {
      const states = Array.isArray(args.states) ? (args.states as string[]) : undefined;
      const pulls = listPulls(repo, states === undefined ? 'all' : states.includes('OPEN') && states.includes('CLOSED') ? 'all' : states.includes('OPEN') ? 'open' : 'closed');
      const connection = buildConnection(pulls.map((pull) => ({ node: pullObject(repo, pull) })), args);
      return selectConnection(exec, connection, selections);
    }
    if (field === 'labels') {
      const connection = buildConnection([...repo.labels.values()].map((label) => ({
        node: { __type: 'Label', id: globalId('Label', repo.id, label.id), name: label.name, color: label.color, description: label.description } as GqlObject,
      })), args);
      return selectConnection(exec, connection, selections);
    }
    if (field === 'defaultBranchRef') {
      const sha = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (sha === undefined) return null;
      return selectObject(exec, {
        __type: 'Ref',
        name: repo.defaultBranch,
        target: { __type: 'GitObject', oid: sha },
      }, selections);
    }
    if (field === 'owner') return selectObject(exec, userObject(repo.owner), selections);
    if (['id', 'databaseId', 'name', 'nameWithOwner', 'description', 'url', 'createdAt'].includes(field)) {
      return object[field];
    }
    exec.errors.push({ message: `Cannot query field "${field}" on type "Repository".` });
    return null;
  }

  if (type === 'Issue') {
    const repo = object.__repo as Repo;
    const issue = object.__issue as Issue;
    if (field === 'labels') {
      const connection = buildConnection(issue.labels.map((label) => ({
        node: { __type: 'Label', id: globalId('Label', repo.id, label.id), name: label.name, color: label.color, description: label.description } as GqlObject,
      })), args);
      return selectConnection(exec, connection, selections);
    }
    if (field === 'comments') {
      const comments = repo.comments.get(issue.number) ?? [];
      const connection = buildConnection(comments.map((comment) => ({
        node: {
          __type: 'IssueComment',
          id: globalId('IssueComment', repo.id, comment.id),
          body: comment.body,
          createdAt: comment.createdAt,
        } as GqlObject,
      })), args);
      return selectConnection(exec, connection, selections);
    }
    if (field === 'repository') return selectObject(exec, repoObject(repo), selections);
    if (field === 'author') return selectObject(exec, userObject(VIEWER_LOGIN), selections);
    if (['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'url'].includes(field)) {
      return object[field];
    }
    exec.errors.push({ message: `Cannot query field "${field}" on type "Issue".` });
    return null;
  }

  if (type === 'PullRequest') {
    const repo = object.__repo as Repo;
    const pull = object.__pull as Pull;
    if (field === 'headRef') return selectObject(exec, { __type: 'Ref', name: pull.headRef, target: { __type: 'GitObject', oid: pull.headSha } }, selections);
    if (field === 'baseRef') return selectObject(exec, { __type: 'Ref', name: pull.baseRef, target: { __type: 'GitObject', oid: pull.baseSha } }, selections);
    if (field === 'mergeable') return pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
    if (field === 'files') {
      const files = pullFiles(repo, pull).map((file) => ({
        node: {
          __type: 'PullRequestFile',
          path: file.filename,
          additions: file.additions,
          deletions: file.deletions,
          changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'REMOVED' : 'MODIFIED',
          status: file.status,
        } as GqlObject,
      }));
      const connection = buildConnection(files, args);
      return selectConnection(exec, connection, selections);
    }
    if (field === 'repository') return selectObject(exec, repoObject(repo), selections);
    if (field === 'author') return selectObject(exec, userObject(VIEWER_LOGIN), selections);
    if (['id', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'merged', 'createdAt', 'updatedAt', 'url'].includes(field)) {
      return object[field];
    }
    exec.errors.push({ message: `Cannot query field "${field}" on type "PullRequest".` });
    return null;
  }

  // Any other object type: plain fields from the object itself.
  if (field in object && typeof object[field] !== 'function') {
    const value = object[field];
    if (Array.isArray(value) && selections !== undefined) {
      return value.map((item) => (item !== null && typeof item === 'object' && '__type' in (item as object) ? selectObject(exec, item as GqlObject, selections) : item));
    }
    if (value !== null && typeof value === 'object' && '__type' in (value as object) && selections !== undefined) {
      return selectObject(exec, value as GqlObject, selections);
    }
    return value;
  }
  exec.errors.push({ message: `Cannot query field "${field}" on type "${type}".` });
  return null;
}

/** Execute a selection set against a GqlObject (or return the scalar as-is). */
function selectObject(exec: Executor, object: GqlObject, selections: Selection[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (selections === undefined) return out;
  executeSelections(exec, object, selections, out);
  return out;
}

/** Execute a selection set against a connection value (edges/nodes/pageInfo/totalCount). */
function selectConnection(exec: Executor, connection: Record<string, unknown>, selections: Selection[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (selections === undefined) return connection;
  for (const selection of selections) {
    if (selection.kind !== 'field') continue;
    const key = selection.alias ?? selection.name!;
    if (selection.name === 'edges') {
      const edges = (connection.edges as Array<{ cursor: string; node: GqlObject }>) ?? [];
      out[key] = edges.map((edge) => {
        const edgeOut: Record<string, unknown> = {};
        for (const sub of selection.selections ?? []) {
          if (sub.kind !== 'field') continue;
          const subKey = sub.alias ?? sub.name!;
          if (sub.name === 'cursor') edgeOut[subKey] = edge.cursor;
          else if (sub.name === 'node') edgeOut[subKey] = selectObject(exec, edge.node, sub.selections);
        }
        return edgeOut;
      });
    } else if (selection.name === 'nodes') {
      const nodes = (connection.nodes as GqlObject[]) ?? [];
      out[key] = nodes.map((node) => selectObject(exec, node, selection.selections));
    } else if (selection.name === 'pageInfo') {
      const pageInfo = connection.pageInfo as Record<string, unknown>;
      const pageOut: Record<string, unknown> = {};
      for (const sub of selection.selections ?? []) {
        if (sub.kind === 'field') pageOut[sub.alias ?? sub.name!] = pageInfo[sub.name!];
      }
      out[key] = pageOut;
    } else if (selection.name === 'totalCount') {
      out[key] = connection.totalCount;
    } else {
      out[key] = null;
      exec.errors.push({ message: `Cannot query field "${selection.name}" on type "Connection".` });
    }
  }
  return out;
}

function resolveMutation(exec: Executor, field: string, args: Record<string, unknown>, selections: Selection[] | undefined): unknown {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const clientMutationId = input.clientMutationId ?? null;
  const wrap = (payload: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...payload };
    if (selections === undefined) return out;
    const result: Record<string, unknown> = {};
    for (const selection of selections) {
      if (selection.kind !== 'field') continue;
      const key = selection.alias ?? selection.name!;
      if (selection.name === 'clientMutationId') {
        result[key] = clientMutationId;
        continue;
      }
      const value = out[selection.name!];
      if (value !== null && typeof value === 'object' && '__type' in (value as object)) {
        result[key] = selectObject(exec, value as GqlObject, selection.selections);
      } else if (value !== null && typeof value === 'object' && 'node' in (value as object)) {
        const edge = value as { node: GqlObject };
        const edgeOut: Record<string, unknown> = {};
        for (const sub of selection.selections ?? []) {
          if (sub.kind !== 'field') continue;
          if (sub.name === 'node') edgeOut[sub.alias ?? sub.name!] = selectObject(exec, edge.node, sub.selections);
          else if (sub.name === 'cursor') edgeOut[sub.alias ?? sub.name!] = cursorFor(0);
        }
        result[key] = edgeOut;
      } else {
        result[key] = value ?? null;
      }
    }
    return result;
  };

  if (field === 'createIssue') {
    const repo = findByGlobalId(exec.store, String(input.repositoryId ?? ''));
    if (repo === null || repo.__type !== 'Repository') {
      exec.errors.push({ message: 'createIssue: repository not found' });
      return null;
    }
    const repoObj = repo.__repo as Repo;
    const issue = createIssue(exec.store, repoObj, { title: String(input.title ?? ''), body: String(input.body ?? '') });
    if ('error' in issue) {
      exec.errors.push({ message: issue.error });
      return null;
    }
    return wrap({ issue: issueObject(repoObj, issue) });
  }
  if (field === 'closeIssue') {
    const found = findByGlobalId(exec.store, String(input.issueId ?? ''));
    if (found === null || found.__type !== 'Issue') {
      exec.errors.push({ message: 'closeIssue: issue not found' });
      return null;
    }
    const repoObj = found.__repo as Repo;
    const issue = found.__issue as Issue;
    const patched = patchIssue(repoObj, issue.number, { state: 'closed' });
    if (patched === null) {
      exec.errors.push({ message: 'closeIssue: issue not found' });
      return null;
    }
    return wrap({ issue: issueObject(repoObj, patched) });
  }
  if (field === 'createPullRequest') {
    const repo = findByGlobalId(exec.store, String(input.repositoryId ?? ''));
    if (repo === null || repo.__type !== 'Repository') {
      exec.errors.push({ message: 'createPullRequest: repository not found' });
      return null;
    }
    const repoObj = repo.__repo as Repo;
    const pull = createPull(repoObj, {
      head: String(input.headRefName ?? ''),
      base: String(input.baseRefName ?? ''),
      title: String(input.title ?? ''),
      body: String(input.body ?? ''),
    });
    if ('error' in pull) {
      exec.errors.push({ message: pull.error });
      return null;
    }
    return wrap({ pullRequest: pullObject(repoObj, pull) });
  }
  if (field === 'mergePullRequest') {
    const found = findByGlobalId(exec.store, String(input.pullRequestId ?? ''));
    if (found === null || found.__type !== 'PullRequest') {
      exec.errors.push({ message: 'mergePullRequest: pull request not found' });
      return null;
    }
    const repoObj = found.__repo as Repo;
    const pull = found.__pull as Pull;
    const result = mergePull(repoObj, pull.number);
    if ('error' in result) {
      exec.errors.push({ message: result.error });
      return null;
    }
    const updated = repoObj.pulls.get(pull.number)!;
    return wrap({ pullRequest: pullObject(repoObj, updated) });
  }
  if (field === 'addComment') {
    const found = findByGlobalId(exec.store, String(input.subjectId ?? ''));
    if (found === null || found.__type !== 'Issue') {
      exec.errors.push({ message: 'addComment: subject not found' });
      return null;
    }
    const repoObj = found.__repo as Repo;
    const issue = found.__issue as Issue;
    const comment = createComment(repoObj, issue.number, String(input.body ?? ''));
    if (comment === null) {
      exec.errors.push({ message: 'addComment: subject not found' });
      return null;
    }
    const node: GqlObject = {
      __type: 'IssueComment',
      id: globalId('IssueComment', repoObj.id, comment.id),
      body: comment.body,
      createdAt: comment.createdAt,
    };
    return wrap({ commentEdge: { node } });
  }
  exec.errors.push({ message: `Cannot query field "${field}" on type "Mutation".` });
  return null;
}

// ---------------------------------------------------------------------------------------------
// HTTP entry point
// ---------------------------------------------------------------------------------------------

export interface GraphqlResult {
  status: number;
  body: Buffer;
}

export function handleGraphql(store: Store, headers: Record<string, string>, body: Buffer): GraphqlResult {
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  const header = headers['authorization'] ?? headers['Authorization'] ?? '';
  const match = /^Bearer\s+(.+)$/.exec(header.trim());
  if (expected !== undefined && expected !== '') {
    if (match === null || match[1] !== expected) {
      return { status: 401, body: Buffer.from(JSON.stringify({ message: 'Requires authentication' }), 'utf8') };
    }
  } else if (match === null || match[1] === '') {
    return { status: 401, body: Buffer.from(JSON.stringify({ message: 'Requires authentication' }), 'utf8') };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return { status: 400, body: Buffer.from(JSON.stringify({ errors: [{ message: 'Problems parsing JSON' }] }), 'utf8') };
  }
  const requests = Array.isArray(payload) ? payload : [payload];
  const results: unknown[] = [];
  for (const request of requests) {
    results.push(executeOne(store, request as Record<string, unknown>));
  }
  const out = Array.isArray(payload) ? results : results[0];
  return { status: 200, body: Buffer.from(JSON.stringify(out), 'utf8') };
}

function executeOne(store: Store, request: Record<string, unknown>): Record<string, unknown> {
  const query = typeof request.query === 'string' ? request.query : '';
  const variables = (request.variables ?? {}) as Record<string, unknown>;
  const operationName = typeof request.operationName === 'string' ? request.operationName : undefined;
  if (query === '') {
    return { errors: [{ message: 'Must provide query string.' }] };
  }
  let parsed: { operations: Operation[]; fragments: Map<string, Fragment> };
  try {
    parsed = new Parser(tokenize(query)).parseDocument();
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : 'Syntax Error' }] };
  }
  const operation = operationName === undefined
    ? parsed.operations[0]
    : parsed.operations.find((op) => op.name === operationName);
  if (operation === undefined) {
    return { errors: [{ message: `Unknown operation named "${operationName}".` }] };
  }
  const exec: Executor = { store, variables, errors: [], fragments: parsed.fragments };
  const root: GqlObject = { __type: operation.kind === 'mutation' ? 'Mutation' : 'Query' };
  const data: Record<string, unknown> = {};
  executeSelections(exec, root, operation.selections, data);
  const result: Record<string, unknown> = { data };
  if (exec.errors.length > 0) result.errors = exec.errors;
  return result;
}
