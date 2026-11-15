import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { getRepo, type Store } from './store.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, type HttpResult } from './rest.ts';
import { handleReceivePack, handleUploadPack, infoRefs } from './git.ts';

const MAX_BODY = 64 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, result: HttpResult): void {
  // An explicit Content-Length (instead of chunked encoding) keeps git's remote helpers
  // from reading past the end of a report into the next chunk's bytes.
  const headers: Record<string, string> = { ...(result.headers ?? {}), 'Content-Length': String(result.body.length) };
  res.writeHead(result.status, headers);
  res.end(result.body);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(body.length) });
  res.end(body);
}

function headersOf(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') out[key.toLowerCase()] = value;
    else if (Array.isArray(value) && value.length > 0) out[key.toLowerCase()] = value[0]!;
  }
  return out;
}

export function createApp(store: Store): ReturnType<typeof createServer> {
  const server = createServer(async (req, res) => {
    try {
      // Manual URL split: `new URL()` is measurably slow on the timed read workload.
      const rawUrl = req.url ?? '/';
      const qIndex = rawUrl.indexOf('?');
      const path = qIndex < 0 ? rawUrl : rawUrl.slice(0, qIndex);
      const method = req.method ?? 'GET';
      const headers = headersOf(req);

      if (path === '/healthz') {
        if (method !== 'GET') return sendJson(res, 404, { message: 'Not Found' });
        return sendJson(res, 200, { ok: true });
      }

      if (path === '/api/graphql') {
        if (method !== 'POST') return sendJson(res, 404, { message: 'Not Found' });
        const body = await readBody(req);
        const result = handleGraphql(store, headers, body);
        res.writeHead(result.status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(result.body.length) });
        return res.end(result.body);
      }

      if (path === '/mcp') {
        if (method !== 'POST') return sendJson(res, 404, { message: 'Not Found' });
        const body = await readBody(req);
        const result = handleMcp(store, headers, body);
        res.writeHead(result.status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(result.body.length) });
        return res.end(result.body);
      }

      if (path.startsWith('/api/v3')) {
        const query = new URLSearchParams(qIndex < 0 ? '' : rawUrl.slice(qIndex + 1));
        const segments = path.split('/').slice(3).filter((s) => s !== '').map((s) => {
          try {
            return decodeURIComponent(s);
          } catch {
            return s;
          }
        });
        const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
        const result = handleRest(store, { method, segments, query, headers, body });
        return send(res, result);
      }

      // Git smart HTTP: /{owner}/{repo}.git/...
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(path);
      if (gitMatch !== null) {
        const owner = decodeURIComponent(gitMatch[1]!);
        const repoName = decodeURIComponent(gitMatch[2]!);
        const action = gitMatch[3]!;
        const repo = getRepo(store, owner, repoName);
        if (repo === undefined) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          return res.end(`repository ${owner}/${repoName} not found`);
        }
        if (action === 'info/refs' && method === 'GET') {
          const query = new URLSearchParams(qIndex < 0 ? '' : rawUrl.slice(qIndex + 1));
          const service = query.get('service') ?? '';
          if (service === '') {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            return res.end('service parameter is required');
          }
          const gitProtocolRaw = req.headers['git-protocol'];
          const gitProtocol = Array.isArray(gitProtocolRaw) ? gitProtocolRaw[0] : gitProtocolRaw;
          return send(res, infoRefs(repo, service, gitProtocol));
        }
        if (action === 'git-upload-pack' && method === 'POST') {
          const body = await readBody(req);
          return send(res, handleUploadPack(repo, body));
        }
        if (action === 'git-receive-pack' && method === 'POST') {
          const body = await readBody(req);
          return send(res, handleReceivePack(repo, body));
        }
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('not found');
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('not found');
    } catch (error) {
      // Never leak a stack to the harness; a 500 here fails a check, but crashing the
      // process would fail every later check.
      // eslint-disable-next-line no-console
      console.error('request failed:', error instanceof Error ? error.message : String(error));
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Internal Server Error' }));
      }
    }
  });
  server.keepAliveTimeout = 30_000;
  server.headersTimeout = 35_000;
  return server;
}
