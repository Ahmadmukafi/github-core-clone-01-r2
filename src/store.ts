import { buildCommit, buildTree, diffTrees, flattenTree, isAncestor, mergeBase, parseCommit, parseTag, parseTree, type GitObject, type GitObjectType } from './objects.ts';
import { b64decode, globalId, hashObject, isoOf, tick, VIEWER_EMAIL, VIEWER_LOGIN, ZERO_OID } from './util.ts';

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  jsonCache: Buffer | null;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  issueOrder: number[];
  pulls: Map<number, Pull>;
  pullOrder: number[];
  labels: Map<string, Label>;
  comments: Map<number, Comment[]>;
  nextNumber: number;
  nextCommentId: number;
  createdSeq: number;
  createdAt: string;
  version: number;
  repoJsonCache: Buffer | null;
  packCache: Map<string, { pack: Buffer; shallow: string[]; unshallow: string[]; encoded: Buffer }>;
  commitSeq: Map<string, number>;
  nextCommitSeq: number;
}

export interface Store {
  repos: Map<string, Repo>;
  nextRepoId: number;
  nextObjectId: number;
  nextCommentId: number;
}

export function createStore(): Store {
  return { repos: new Map(), nextRepoId: 10000, nextObjectId: 100000, nextCommentId: 1 };
}

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function fullName(repo: Repo): string {
  return `${repo.owner}/${repo.name}`;
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: fullName(repo),
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    html_url: `https://github.com/${fullName(repo)}`,
    clone_url: `https://github.com/${fullName(repo)}.git`,
    has_issues: true,
    fork: false,
  };
}

/** Cached serialized REST form of a repo (invalidated by PATCH). */
export function repoRestJson(repo: Repo): Buffer {
  if (repo.repoJsonCache === null) {
    repo.repoJsonCache = Buffer.from(JSON.stringify(repoJson(repo)), 'utf8');
  }
  return repo.repoJsonCache;
}

export function issueRestJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ id: label.id, name: label.name, color: label.color, description: label.description })),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

/** Cached serialized REST form of an issue (invalidated by PATCH). */
export function issueRestBuffer(repo: Repo, issue: Issue): Buffer {
  if (issue.jsonCache === null) {
    issue.jsonCache = Buffer.from(JSON.stringify(issueRestJson(repo, issue)), 'utf8');
  }
  return issue.jsonCache;
}

export function pullRestJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `https://github.com/${fullName(repo)}/pull/${pull.number}`,
  };
}

export function createRepo(
  store: Store,
  owner: string,
  name: string,
  opts: { private: boolean; description: string },
): Repo | null {
  const key = repoKey(owner, name);
  if (store.repos.has(key)) return null;
  const seq = tick();
  const repo: Repo = {
    id: store.nextRepoId++,
    owner,
    name,
    private: opts.private,
    description: opts.description,
    defaultBranch: 'main',
    objects: new Map(),
    refs: new Map(),
    issues: new Map(),
    issueOrder: [],
    pulls: new Map(),
    pullOrder: [],
    labels: new Map(),
    comments: new Map(),
    nextNumber: 1,
    nextCommentId: 1,
    createdSeq: seq,
    createdAt: isoOf(seq),
    version: 0,
    repoJsonCache: null,
    packCache: new Map(),
    commitSeq: new Map(),
    nextCommitSeq: 0,
  };
  store.repos.set(key, repo);
  return repo;
}

export function getRepo(store: Store, owner: string, name: string): Repo | undefined {
  return store.repos.get(repoKey(owner, name));
}

export function deleteRepo(store: Store, owner: string, name: string): boolean {
  return store.repos.delete(repoKey(owner, name));
}

export function listReposByOwner(store: Store, owner: string): Repo[] {
  const out: Repo[] = [];
  for (const repo of store.repos.values()) {
    if (repo.owner === owner) out.push(repo);
  }
  out.sort((a, b) => a.createdSeq - b.createdSeq);
  return out;
}

// ---------------------------------------------------------------------------------------------
// git objects
// ---------------------------------------------------------------------------------------------

export function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) {
    repo.objects.set(oid, { type, data });
    if (type === 'commit') repo.commitSeq.set(oid, repo.nextCommitSeq++);
  }
  return oid;
}

export function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

export function lookupOf(repo: Repo): (oid: string) => GitObject | undefined {
  return (oid: string) => repo.objects.get(oid);
}

/** Resolve a ref name (short, full, or HEAD) to its oid. */
export function resolveRef(repo: Repo, name: string): string | undefined {
  if (name === 'HEAD') return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (name.startsWith('refs/')) return repo.refs.get(name);
  return repo.refs.get(`refs/heads/${name}`);
}

/** Peel an annotated tag to the commit it points at. */
export function peelToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let i = 0; i < 10; i += 1) {
    const obj = repo.objects.get(current);
    if (obj === undefined) return null;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      current = parseTag(obj.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/** Build a new tree from a base tree with path changes applied (value null deletes). */
export function treeWithChanges(
  repo: Repo,
  baseTreeOid: string | null,
  changes: Map<string, Buffer | null>,
): string {
  const flat = new Map<string, { oid: string; mode: string }>();
  if (baseTreeOid !== null) flattenTree(baseTreeOid, lookupOf(repo), flat);
  for (const [path, data] of changes) {
    if (data === null) flat.delete(path);
    else flat.set(path, { oid: putObject(repo, 'blob', data), mode: '100644' });
  }
  // Rebuild bottom-up: group paths into a directory tree.
  interface Dir {
    files: Map<string, string>;
    dirs: Map<string, Dir>;
  }
  const makeDir = (): Dir => ({ files: new Map(), dirs: new Map() });
  const root = makeDir();
  for (const [path, entry] of flat) {
    const segments = path.split('/');
    let dir = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i]!;
      let child = dir.dirs.get(name);
      if (child === undefined) {
        child = makeDir();
        dir.dirs.set(name, child);
      }
      dir = child;
    }
    dir.files.set(segments[segments.length - 1]!, entry.oid);
  }
  const build = (dir: Dir): string => {
    const entries: Array<{ mode: string; name: string; oid: string }> = [];
    for (const [name, oid] of dir.files) entries.push({ mode: '100644', name, oid });
    for (const [name, child] of dir.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

export function createCommit(
  repo: Repo,
  opts: { tree: string; parents: readonly string[]; message: string },
): string {
  const ts = tick();
  const identity = `${VIEWER_LOGIN} <${VIEWER_EMAIL}>`;
  const data = buildCommit({ tree: opts.tree, parents: opts.parents, message: opts.message, author: identity, committer: identity, timestamp: ts });
  return putObject(repo, 'commit', data);
}

/** Commits reachable from a tip, newest first (by store sequence). */
export function listCommits(repo: Repo, tip: string): Array<{ sha: string; message: string; seq: number }> {
  const seen = new Set<string>();
  const queue: string[] = [tip];
  const out: Array<{ sha: string; message: string; seq: number }> = [];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const commit = parseCommit(obj.data);
    out.push({ sha: oid, message: commit.message, seq: repo.commitSeq.get(oid) ?? 0 });
    for (const parent of commit.parents) queue.push(parent);
  }
  out.sort((a, b) => b.seq - a.seq);
  return out;
}

// ---------------------------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------------------------

export function createIssue(
  store: Store,
  repo: Repo,
  input: { title: string; body: string; labels?: readonly string[] },
): Issue | { error: string } {
  const labels: Label[] = [];
  for (const name of input.labels ?? []) {
    const label = repo.labels.get(name);
    if (label === undefined) return { error: `unknown label ${name}` };
    labels.push(label);
  }
  const seq = tick();
  const at = isoOf(seq);
  const issue: Issue = {
    id: store.nextObjectId++,
    number: repo.nextNumber++,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels,
    createdSeq: seq,
    createdAt: at,
    updatedAt: at,
    jsonCache: null,
  };
  repo.issues.set(issue.number, issue);
  repo.issueOrder.push(issue.number);
  return issue;
}

export function listIssues(
  repo: Repo,
  opts: { state?: string; sort?: string; direction?: string },
): Issue[] {
  const state = opts.state ?? 'open';
  const out: Issue[] = [];
  for (const number of repo.issueOrder) {
    const issue = repo.issues.get(number)!;
    if (state === 'all' || issue.state === state) out.push(issue);
  }
  const direction = opts.direction ?? 'desc';
  if (opts.sort === 'created' || opts.sort === undefined) {
    out.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
  }
  return out;
}

export function patchIssue(repo: Repo, number: number, patch: { state?: string; title?: string; body?: string }): Issue | null {
  const issue = repo.issues.get(number);
  if (issue === undefined) return null;
  if (patch.state === 'open' || patch.state === 'closed') issue.state = patch.state;
  if (typeof patch.title === 'string') issue.title = patch.title;
  if (typeof patch.body === 'string') issue.body = patch.body;
  issue.updatedAt = isoOf(tick());
  issue.jsonCache = null;
  return issue;
}

export function createComment(repo: Repo, issueNumber: number, body: string): Comment | null {
  if (!repo.issues.has(issueNumber)) return null;
  const comment: Comment = { id: repo.nextCommentId++, body, createdAt: isoOf(tick()) };
  let list = repo.comments.get(issueNumber);
  if (list === undefined) {
    list = [];
    repo.comments.set(issueNumber, list);
  }
  list.push(comment);
  return comment;
}

export function createLabel(repo: Repo, name: string, color: string): Label {
  const existing = repo.labels.get(name);
  if (existing !== undefined) return existing;
  const label: Label = { id: repo.labels.size + 1, name, color: color || 'ededed', description: '' };
  repo.labels.set(name, label);
  return label;
}

// ---------------------------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------------------------

export function createPull(
  repo: Repo,
  input: { head: string; base: string; title: string; body: string },
): Pull | { error: string } {
  const headSha = resolveRef(repo, input.head);
  const baseSha = resolveRef(repo, input.base);
  if (headSha === undefined || baseSha === undefined) return { error: 'unknown head or base ref' };
  for (const number of repo.pullOrder) {
    const existing = repo.pulls.get(number)!;
    if (existing.state === 'open' && existing.headRef === input.head && existing.baseRef === input.base) {
      return { error: 'a pull request already exists for this head' };
    }
  }
  const seq = tick();
  const at = isoOf(seq);
  const pull: Pull = {
    id: repo.id * 100000 + repo.nextNumber,
    number: repo.nextNumber++,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    headRef: input.head,
    baseRef: input.base,
    headSha,
    baseSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    createdSeq: seq,
    createdAt: at,
    updatedAt: at,
  };
  repo.pulls.set(pull.number, pull);
  repo.pullOrder.push(pull.number);
  return pull;
}

export function listPulls(repo: Repo, state: string): Pull[] {
  const out: Pull[] = [];
  for (const number of repo.pullOrder) {
    const pull = repo.pulls.get(number)!;
    if (state === 'all' || pull.state === state) out.push(pull);
  }
  return out;
}

/** Line-level added/removed counts between two blobs (prefix+suffix diff). */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  if (oldText === newText) return { additions: 0, deletions: 0 };
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return {
    additions: newLines.length - prefix - suffix,
    deletions: oldLines.length - prefix - suffix,
  };
}

export interface PullFileEntry {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}

/** The changed files of a pull request: merge-base tree vs head tree. */
export function pullFiles(repo: Repo, pull: Pull): PullFileEntry[] {
  const lookup = lookupOf(repo);
  const headCommit = peelToCommit(repo, pull.headSha);
  const baseCommit = peelToCommit(repo, pull.baseSha);
  if (headCommit === null || baseCommit === null) return [];
  const base = mergeBase(baseCommit, headCommit, lookup);
  const baseTree = base === null ? null : parseCommit(repo.objects.get(base)!.data).tree;
  const headTree = parseCommit(repo.objects.get(headCommit)!.data).tree;
  const diffs = diffTrees(baseTree, headTree, lookup);
  const out: PullFileEntry[] = [];
  for (const diff of diffs) {
    const oldText = diff.oldOid === null ? '' : (repo.objects.get(diff.oldOid)?.data.toString('utf8') ?? '');
    const newText = diff.newOid === null ? '' : (repo.objects.get(diff.newOid)?.data.toString('utf8') ?? '');
    const { additions, deletions } = lineDiff(oldText, newText);
    const status = diff.oldOid === null ? 'added' : diff.newOid === null ? 'removed' : 'modified';
    out.push({ filename: diff.path, status, additions, deletions, changes: additions + deletions });
  }
  return out;
}

/** Would merging this pull request conflict? (three-way, per file, against the CURRENT base tip) */
export function pullMergeable(repo: Repo, pull: Pull): boolean {
  const lookup = lookupOf(repo);
  const headCommit = peelToCommit(repo, pull.headSha);
  const baseTipOid = resolveRef(repo, pull.baseRef) ?? pull.baseSha;
  const baseTip = peelToCommit(repo, baseTipOid);
  if (headCommit === null || baseTip === null) return false;
  const base = mergeBase(baseTip, headCommit, lookup);
  if (base === null) return false;
  const baseFlat = new Map<string, { oid: string; mode: string }>();
  const oursFlat = new Map<string, { oid: string; mode: string }>();
  const theirsFlat = new Map<string, { oid: string; mode: string }>();
  flattenTree(parseCommit(repo.objects.get(base)!.data).tree, lookup, baseFlat);
  flattenTree(parseCommit(repo.objects.get(baseTip)!.data).tree, lookup, oursFlat);
  flattenTree(parseCommit(repo.objects.get(headCommit)!.data).tree, lookup, theirsFlat);
  const paths = new Set([...baseFlat.keys(), ...oursFlat.keys(), ...theirsFlat.keys()]);
  for (const path of paths) {
    const b = baseFlat.get(path)?.oid ?? null;
    const o = oursFlat.get(path)?.oid ?? null;
    const t = theirsFlat.get(path)?.oid ?? null;
    if (t === b) continue;
    if (o === b) continue;
    if (o === t) continue;
    return false;
  }
  return true;
}

export function mergePull(repo: Repo, number: number): { sha: string } | { error: string; status: number } {
  const pull = repo.pulls.get(number);
  if (pull === undefined) return { error: 'pull request not found', status: 404 };
  if (pull.state !== 'open') return { error: 'pull request is not open', status: 405 };
  if (!pullMergeable(repo, pull)) return { error: 'merge conflict', status: 405 };
  const lookup = lookupOf(repo);
  const headCommit = peelToCommit(repo, pull.headSha)!;
  const baseTipOid = resolveRef(repo, pull.baseRef) ?? pull.baseSha;
  const baseTip = peelToCommit(repo, baseTipOid)!;
  const base = mergeBase(baseTip, headCommit, lookup)!;
  const baseFlat = new Map<string, { oid: string; mode: string }>();
  const oursFlat = new Map<string, { oid: string; mode: string }>();
  const theirsFlat = new Map<string, { oid: string; mode: string }>();
  flattenTree(parseCommit(repo.objects.get(base)!.data).tree, lookup, baseFlat);
  flattenTree(parseCommit(repo.objects.get(baseTip)!.data).tree, lookup, oursFlat);
  flattenTree(parseCommit(repo.objects.get(headCommit)!.data).tree, lookup, theirsFlat);
  const merged = new Map(oursFlat);
  for (const [path, entry] of theirsFlat) {
    const b = baseFlat.get(path)?.oid ?? null;
    const o = oursFlat.get(path)?.oid ?? null;
    if (entry.oid !== b && o === b) merged.set(path, entry);
  }
  for (const path of [...baseFlat.keys()]) {
    const b = baseFlat.get(path)?.oid ?? null;
    const o = oursFlat.get(path)?.oid ?? null;
    const t = theirsFlat.get(path);
    if (t === undefined && o === b) merged.delete(path);
  }
  const changes = new Map<string, Buffer | null>();
  const current = new Map<string, { oid: string; mode: string }>();
  flattenTree(parseCommit(repo.objects.get(baseTip)!.data).tree, lookup, current);
  for (const [path, entry] of merged) {
    const cur = current.get(path);
    if (cur === undefined || cur.oid !== entry.oid) {
      changes.set(path, repo.objects.get(entry.oid)?.data ?? null);
    }
  }
  for (const path of current.keys()) {
    if (!merged.has(path)) changes.set(path, null);
  }
  const baseTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
  const tree = treeWithChanges(repo, baseTree, changes);
  const sha = createCommit(repo, {
    tree,
    parents: [baseTip],
    message: `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`,
  });
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  repo.version += 1;
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = isoOf(tick());
  pull.mergeCommitSha = sha;
  pull.updatedAt = isoOf(tick());
  return { sha };
}

// ---------------------------------------------------------------------------------------------
// contents API
// ---------------------------------------------------------------------------------------------

export interface ContentFile {
  type: 'file';
  name: string;
  path: string;
  sha: string;
  size: number;
  content: Buffer;
}

export interface ContentDirEntry {
  type: 'file' | 'dir';
  name: string;
  path: string;
  sha: string;
  size?: number;
}

/** Read a path from a branch's tree: a file, a directory listing, or null. */
export function readContent(
  repo: Repo,
  path: string,
  ref: string | undefined,
): { file: ContentFile } | { dir: ContentDirEntry[] } | null {
  const tipOid = ref === undefined ? resolveRef(repo, repo.defaultBranch) : resolveRef(repo, ref);
  if (tipOid === undefined) return null;
  const commitOid = peelToCommit(repo, tipOid);
  if (commitOid === null) return null;
  const commit = repo.objects.get(commitOid);
  if (commit === undefined) return null;
  const rootTree = parseCommit(commit.data).tree;
  const clean = path.replace(/^\/+|\/+$/g, '');
  if (clean === '') {
    const entries = listTreeDir(repo, rootTree, '');
    return entries === null ? null : { dir: entries };
  }
  const flat = new Map<string, { oid: string; mode: string }>();
  flattenTree(rootTree, lookupOf(repo), flat);
  const direct = flat.get(clean);
  if (direct !== undefined) {
    const blob = repo.objects.get(direct.oid);
    if (blob === undefined) return null;
    return {
      file: {
        type: 'file',
        name: clean.split('/').pop()!,
        path: clean,
        sha: direct.oid,
        size: blob.data.length,
        content: blob.data,
      },
    };
  }
  // A directory: any path under clean/ ?
  const prefix = `${clean}/`;
  let isDir = false;
  for (const key of flat.keys()) {
    if (key.startsWith(prefix)) {
      isDir = true;
      break;
    }
  }
  if (!isDir) return null;
  const entries = listTreeDir(repo, rootTree, clean);
  return entries === null ? null : { dir: entries };
}

/** List the direct children of a directory inside a tree. */
function listTreeDir(repo: Repo, rootTree: string, dirPath: string): ContentDirEntry[] | null {
  const segments = dirPath === '' ? [] : dirPath.split('/');
  let treeOid = rootTree;
  for (const segment of segments) {
    const tree = repo.objects.get(treeOid);
    if (tree === undefined) return null;
    const entry = parseTree(tree.data).find((e) => e.name === segment && e.mode === '40000');
    if (entry === undefined) return null;
    treeOid = entry.oid;
  }
  const tree = repo.objects.get(treeOid);
  if (tree === undefined) return null;
  const out: ContentDirEntry[] = [];
  for (const entry of parseTree(tree.data)) {
    const childPath = dirPath === '' ? entry.name : `${dirPath}/${entry.name}`;
    if (entry.mode === '40000') {
      out.push({ type: 'dir', name: entry.name, path: childPath, sha: entry.oid });
    } else {
      const blob = repo.objects.get(entry.oid);
      out.push({ type: 'file', name: entry.name, path: childPath, sha: entry.oid, size: blob?.data.length ?? 0 });
    }
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

export function putContent(
  repo: Repo,
  opts: { path: string; contentB64: string; message: string; sha?: string; branch?: string },
): { contentSha: string; commitSha: string } | { error: string; status: number } {
  const clean = opts.path.replace(/^\/+/, '');
  const branch = opts.branch ?? repo.defaultBranch;
  let tipOid = resolveRef(repo, branch);
  if (tipOid === undefined) {
    // A contents write creates the branch from the default branch tip (or starts the repo).
    const baseTip = resolveRef(repo, repo.defaultBranch);
    if (baseTip !== undefined) {
      repo.refs.set(`refs/heads/${branch}`, baseTip);
      tipOid = baseTip;
    }
  }
  const data = b64decode(opts.contentB64);
  if (tipOid !== undefined) {
    const commitOid = peelToCommit(repo, tipOid);
    if (commitOid === null) return { error: 'branch has no commit', status: 422 };
    const commit = repo.objects.get(commitOid)!;
    const rootTree = parseCommit(commit.data).tree;
    const flat = new Map<string, { oid: string; mode: string }>();
    flattenTree(rootTree, lookupOf(repo), flat);
    const existing = flat.get(clean);
    if (opts.sha === undefined) {
      if (existing !== undefined) return { error: 'file already exists', status: 422 };
    } else {
      if (existing === undefined) return { error: 'file does not exist', status: 422 };
      if (existing.oid !== opts.sha) return { error: 'sha does not match', status: 409 };
    }
    const tree = treeWithChanges(repo, rootTree, new Map([[clean, data]]));
    const commitSha = createCommit(repo, { tree, parents: [commitOid], message: opts.message });
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    repo.version += 1;
    return { contentSha: hashObject('blob', data), commitSha };
  }
  // Unborn repository: the first commit.
  const tree = treeWithChanges(repo, null, new Map([[clean, data]]));
  const commitSha = createCommit(repo, { tree, parents: [], message: opts.message });
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  repo.version += 1;
  return { contentSha: hashObject('blob', data), commitSha };
}

export function deleteContent(
  repo: Repo,
  opts: { path: string; message: string; sha: string; branch?: string },
): { commitSha: string } | { error: string; status: number } {
  const clean = opts.path.replace(/^\/+/, '');
  const branch = opts.branch ?? repo.defaultBranch;
  const tipOid = resolveRef(repo, branch);
  if (tipOid === undefined) return { error: 'branch not found', status: 404 };
  const commitOid = peelToCommit(repo, tipOid);
  if (commitOid === null) return { error: 'branch has no commit', status: 422 };
  const commit = repo.objects.get(commitOid)!;
  const rootTree = parseCommit(commit.data).tree;
  const flat = new Map<string, { oid: string; mode: string }>();
  flattenTree(rootTree, lookupOf(repo), flat);
  const existing = flat.get(clean);
  if (existing === undefined) return { error: 'file does not exist', status: 404 };
  if (existing.oid !== opts.sha) return { error: 'sha does not match', status: 409 };
  const tree = treeWithChanges(repo, rootTree, new Map([[clean, null]]));
  const commitSha = createCommit(repo, { tree, parents: [commitOid], message: opts.message });
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  repo.version += 1;
  return { commitSha };
}

export { ZERO_OID };
