import { b64encode } from './util.ts';
import {
  createIssue,
  createPull,
  createRepo,
  getRepo,
  issueRestJson,
  listIssues,
  mergePull,
  pullRestJson,
  repoRestJson,
} from './store.ts';
import type { Store } from './store.ts';

export interface McpResult {
  status: number;
  body: Buffer;
}

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2026-07-28';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// One frozen definition list: tools/list serializes byte-identically on every call.
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['owner', 'name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        labels: { type: 'array', items: { type: 'string' } },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        state: { type: 'string', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        head: { type: 'string' },
        base: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['owner', 'repo', 'head', 'base', 'title'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        number: { type: 'integer' },
      },
      required: ['owner', 'repo', 'number'],
    },
  },
];

const TOOLS_LIST_JSON = JSON.stringify({ tools: TOOLS });

type JsonRpcId = string | number | null;

function rpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toolText(value: unknown): Record<string, unknown> {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: typeof value === 'object' ? value : { text } };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function requireArgs(args: Record<string, unknown>, names: string[]): string | null {
  for (const name of names) {
    if (args[name] === undefined || args[name] === null || args[name] === '') return `missing required argument: ${name}`;
  }
  return null;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const missing = requireArgs(args, TOOLS.find((t) => t.name === name)?.inputSchema.required as string[] ?? []);
  if (missing !== null) return toolError(missing);
  const owner = String(args.owner ?? '');
  const repoName = String(args.repo ?? args.name ?? '');

  switch (name) {
    case 'create_repo': {
      const repo = createRepo(store, owner, String(args.name ?? ''), {
        private: args.private === true,
        description: typeof args.description === 'string' ? args.description : '',
      });
      if (repo === null) return toolError(`repository ${owner}/${args.name} already exists`);
      return toolText(JSON.parse(repoRestJson(repo).toString('utf8')));
    }
    case 'get_repo': {
      const repo = getRepo(store, owner, repoName);
      if (repo === undefined) return toolError(`repository ${owner}/${repoName} not found`);
      return toolText(JSON.parse(repoRestJson(repo).toString('utf8')));
    }
    case 'create_issue': {
      const repo = getRepo(store, owner, repoName);
      if (repo === undefined) return toolError(`repository ${owner}/${repoName} not found`);
      const labels = Array.isArray(args.labels) ? args.labels.filter((x): x is string => typeof x === 'string') : [];
      const issue = createIssue(store, repo, { title: String(args.title ?? ''), body: String(args.body ?? ''), labels });
      if ('error' in issue) return toolError(issue.error);
      return toolText(issueRestJson(repo, issue));
    }
    case 'list_issues': {
      const repo = getRepo(store, owner, repoName);
      if (repo === undefined) return toolError(`repository ${owner}/${repoName} not found`);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = listIssues(repo, { state, sort: 'created', direction: 'desc' });
      return toolText(issues.map((issue) => issueRestJson(repo, issue)));
    }
    case 'create_pull_request': {
      const repo = getRepo(store, owner, repoName);
      if (repo === undefined) return toolError(`repository ${owner}/${repoName} not found`);
      const pull = createPull(repo, {
        head: String(args.head ?? ''),
        base: String(args.base ?? ''),
        title: String(args.title ?? ''),
        body: String(args.body ?? ''),
      });
      if ('error' in pull) return toolError(pull.error);
      return toolText(pullRestJson(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = getRepo(store, owner, repoName);
      if (repo === undefined) return toolError(`repository ${owner}/${repoName} not found`);
      const result = mergePull(repo, Number(args.number));
      if ('error' in result) return toolError(result.error);
      return toolText({ merged: true, sha: result.sha, message: 'Pull Request successfully merged' });
    }
    default:
      return toolError(`unknown tool: ${name}`);
  }
}

export function handleMcp(store: Store, headers: Record<string, string>, body: Buffer): McpResult {
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

  let request: unknown;
  try {
    request = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return {
      status: 400,
      body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }), 'utf8'),
    };
  }
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    return {
      status: 200,
      body: Buffer.from(JSON.stringify(rpcError(null, -32600, 'Invalid Request')), 'utf8'),
    };
  }
  const req = request as Record<string, unknown>;
  const id = (typeof req.id === 'string' || typeof req.id === 'number' ? req.id : null) as JsonRpcId;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params ?? {}) as Record<string, unknown>;

  // Notifications carry no id and get no response.
  if (id === null && req.id === undefined) {
    return { status: 202, body: Buffer.alloc(0) };
  }

  let response: Record<string, unknown>;
  switch (method) {
    case 'server/discover': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION;
      const version = SUPPORTED_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSION;
      response = rpcResult(id, {
        protocolVersion: version,
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      break;
    }
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION;
      const version = SUPPORTED_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSION;
      response = rpcResult(id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      break;
    }
    case 'tools/list': {
      response = rpcResult(id, JSON.parse(TOOLS_LIST_JSON) as Record<string, unknown>);
      break;
    }
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      if (TOOLS.find((t) => t.name === toolName) === undefined) {
        response = rpcError(id, -32601, `unknown tool: ${toolName}`);
        break;
      }
      response = rpcResult(id, callTool(store, toolName, args));
      break;
    }
    case 'ping': {
      response = rpcResult(id, {});
      break;
    }
    default: {
      response = rpcError(id, -32601, `method not found: ${method}`);
      break;
    }
  }
  return { status: 200, body: Buffer.from(JSON.stringify(response), 'utf8') };
}

export { b64encode };
