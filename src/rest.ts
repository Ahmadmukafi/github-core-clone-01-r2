import {
  createComment,
  createIssue,
  createLabel,
  createPull,
  createRepo,
  deleteContent,
  deleteRepo,
  getObject,
  getRepo,
  issueRestBuffer,
  issueRestJson,
  listCommits,
  listIssues,
  listPulls,
  listReposByOwner,
  mergePull,
  patchIssue,
  pullFiles,
  pullMergeable,
  pullRestJson,
  putContent,
  readContent,
  repoRestJson,
  resolveRef,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { listRefs } from './git.ts';
import { buildTag, parseCommit, parseTag, parseTree } from './objects.ts';
import { b64encode, hashObject, isOid, tick, VIEWER_EMAIL, VIEWER_LOGIN } from './util.ts';

export interface HttpResult {
  status: number;
  headers?: Record<string, string>;
  body: Buffer;
}

let requestSeq = 0;

function json(status: number, value: unknown, extra?: Record<string, string>): HttpResult {
  return {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-GitHub-Request-Id': `req_${++requestSeq}_${tick()}`,
      ...extra,
    },
    body: Buffer.from(JSON.stringify(value), 'utf8'),
  };
}

function jsonBuffer(status: number, body: Buffer, extra?: Record<string, string>): HttpResult {
  return {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-GitHub-Request-Id': `req_${++requestSeq}_${tick()}`,
      ...extra,
    },
    body,
  };
}

function error(status: number, message: string): HttpResult {
  return json(status, { message, documentation_url: 'https://docs.github.com/rest' });
}

export interface AuthResult {
  ok: boolean;
  status?: number;
}

/** Bearer check: any non-empty token locally; exact match when MAKEFUN_SHOP_TOKEN is set. */
export function checkAuth(headers: Record<string, string>): AuthResult {
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  const header = headers['authorization'] ?? headers['Authorization'] ?? '';
  const match = /^Bearer\s+(.+)$/.exec(header.trim());
  if (expected !== undefined && expected !== '') {
    if (match === null || match[1] !== expected) return { ok: false, status: 401 };
    return { ok: true };
  }
  if (match === null || match[1] === '') return { ok: false, status: 401 };
  return { ok: true };
}

export function userJson(login: string): Record<string, unknown> {
  return {
    login,
    id: login === VIEWER_LOGIN ? 1000 : 2000,
    type: 'User',
    avatar_url: `https://github.com/${login}.png`,
    html_url: `https://github.com/${login}`,
    url: `/api/v3/users/${login}`,
  };
}

function ownerOr404(owner: string): HttpResult | null {
  if (owner !== VIEWER_LOGIN) return error(404, `Not Found: user ${owner}`);
  return null;
}

export interface RestRequest {
  method: string;
  segments: string[];
  query: URLSearchParams;
  headers: Record<string, string>;
  body: Buffer;
}

function parseJsonBody(req: RestRequest): { value: Record<string, unknown> | null; malformed: boolean } {
  if (req.body.length === 0) return { value: null, malformed: false };
  try {
    const parsed = JSON.parse(req.body.toString('utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { value: null, malformed: true };
    return { value: parsed as Record<string, unknown>, malformed: false };
  } catch {
    return { value: null, malformed: true };
  }
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

export function handleRest(store: Store, req: RestRequest): HttpResult {
  const auth = checkAuth(req.headers);
  if (!auth.ok) return error(auth.status ?? 401, 'Requires authentication');
  const [first, second, third, ..._rest] = req.segments;

  // GET /api/v3/ — root
  if (req.segments.length === 0) {
    if (req.method !== 'GET') return error(404, 'Not Found');
    return json(200, { current_user_url: '/api/v3/user', repository_url: '/api/v3/repos/{owner}/{repo}' }, { 'X-OAuth-Scopes': 'repo, read:org' });
  }

  // GET /api/v3/meta
  if (first === 'meta' && req.segments.length === 1) {
    if (req.method !== 'GET') return error(404, 'Not Found');
    return json(200, {
      verifiable_password_authentication: true,
      installed_version: '1.0.0',
      github_services_sha: '0000000000000000000000000000000000000000',
      hooks: ['pre-receive', 'post-receive'],
      git: ['127.0.0.1'],
      pages: ['127.0.0.1'],
    });
  }

  // GET /api/v3/user
  if (first === 'user' && req.segments.length === 1) {
    if (req.method !== 'GET') return error(404, 'Not Found');
    return json(200, userJson(VIEWER_LOGIN));
  }

  // /api/v3/user/repos — POST creates, GET lists (paginated, Link rel="next")
  if (first === 'user' && second === 'repos' && req.segments.length === 2) {
    if (req.method === 'GET') {
      const perPage = Math.min(100, Math.max(1, Number.parseInt(req.query.get('per_page') ?? '30', 10) || 30));
      const page = Math.max(1, Number.parseInt(req.query.get('page') ?? '1', 10) || 1);
      const repos = listReposByOwner(store, VIEWER_LOGIN);
      const totalPages = Math.max(1, Math.ceil(repos.length / perPage));
      const slice = repos.slice((page - 1) * perPage, page * perPage);
      const host = req.headers['host'] ?? '127.0.0.1';
      const base = `http://${host}/api/v3/user/repos`;
      const links: string[] = [];
      if (page < totalPages) links.push(`<${base}?per_page=${perPage}&page=${page + 1}>; rel="next"`);
      if (page > 1) links.push(`<${base}?per_page=${perPage}&page=1>; rel="first"`);
      if (totalPages > 1) links.push(`<${base}?per_page=${perPage}&page=${totalPages}>; rel="last"`);
      const extra: Record<string, string> = {};
      if (links.length > 0) extra.Link = links.join(', ');
      return json(200, slice.map((repo) => JSON.parse(repoRestJson(repo).toString('utf8'))), extra);
    }
    if (req.method !== 'POST') return error(404, 'Not Found');
    const parsed = parseJsonBody(req);
    if (parsed.malformed) return error(400, 'Problems parsing JSON');
    const name = str(parsed.value?.name);
    if (name === '') return error(422, 'name is required');
    const repo = createRepo(store, VIEWER_LOGIN, name, {
      private: parsed.value?.private === true,
      description: str(parsed.value?.description),
    });
    if (repo === null) return error(422, 'name already exists on this account');
    return jsonBuffer(201, repoRestJson(repo));
  }

  // /api/v3/users/:login and /api/v3/users/:login/repos
  if (first === 'users' && second !== undefined) {
    if (second !== VIEWER_LOGIN) return error(404, `Not Found: user ${second}`);
    if (req.segments.length === 2) {
      if (req.method !== 'GET') return error(404, 'Not Found');
      return json(200, userJson(second));
    }
    if (third === 'repos' && req.segments.length === 3) {
      if (req.method !== 'GET') return error(404, 'Not Found');
      return json(200, listReposByOwner(store, second).map((repo) => JSON.parse(repoRestJson(repo).toString('utf8'))));
    }
    return error(404, 'Not Found');
  }

  // /api/v3/repos/:owner/:repo/...
  if (first === 'repos' && second !== undefined && third !== undefined) {
    const owner = second;
    const repoName = third;
    const foreign = ownerOr404(owner);
    if (foreign !== null) return foreign;
    const repo = getRepo(store, owner, repoName);
    const tail = req.segments.slice(3); // segments after /repos/:owner/:repo

    // Repo itself
    if (tail.length === 0) {
      if (req.method === 'GET') {
        if (repo === undefined) return error(404, 'Not Found');
        return jsonBuffer(200, repoRestJson(repo));
      }
      if (req.method === 'PATCH') {
        if (repo === undefined) return error(404, 'Not Found');
        const parsed = parseJsonBody(req);
        if (parsed.malformed) return error(400, 'Problems parsing JSON');
        if (typeof parsed.value?.description === 'string') repo.description = parsed.value.description;
        if (typeof parsed.value?.default_branch === 'string') repo.defaultBranch = parsed.value.default_branch;
        repo.repoJsonCache = null;
        return jsonBuffer(200, repoRestJson(repo));
      }
      if (req.method === 'DELETE') {
        if (repo === undefined) return error(404, 'Not Found');
        deleteRepo(store, owner, repoName);
        return json(204, null);
      }
      return error(404, 'Not Found');
    }
    if (repo === undefined) return error(404, 'Not Found');
    return handleRepoSub(store, repo, tail, req);
  }
  return error(404, 'Not Found');
}

function handleRepoSub(store: Store, repo: Repo, tail: string[], req: RestRequest): HttpResult {
  const [resource, a, b] = tail;

  if (resource === 'issues') {
    if (a === undefined) {
      if (req.method === 'GET') {
        const issues = listIssues(repo, {
          state: req.query.get('state') ?? undefined,
          sort: req.query.get('sort') ?? undefined,
          direction: req.query.get('direction') ?? undefined,
        });
        return json(200, issues.map((issue) => issueRestJson(repo, issue)));
      }
      if (req.method === 'POST') {
        const parsed = parseJsonBody(req);
        if (parsed.malformed) return error(400, 'Problems parsing JSON');
        const title = str(parsed.value?.title);
        if (title === '') return error(422, 'title is required');
        const labels = Array.isArray(parsed.value?.labels) ? parsed.value.labels.filter((x): x is string => typeof x === 'string') : [];
        const issue = createIssue(store, repo, { title, body: str(parsed.value?.body), labels });
        if ('error' in issue) return error(422, issue.error);
        return jsonBuffer(201, issueRestBuffer(repo, issue));
      }
      return error(404, 'Not Found');
    }
    const number = Number.parseInt(a, 10);
    if (!Number.isInteger(number)) return error(404, 'Not Found');
    if (b === 'comments') {
      if (req.method === 'GET') {
        const comments = repo.comments.get(number) ?? [];
        return json(200, comments.map((c) => ({ id: c.id, body: c.body, created_at: c.createdAt, user: userJson(VIEWER_LOGIN) })));
      }
      if (req.method === 'POST') {
        const parsed = parseJsonBody(req);
        if (parsed.malformed) return error(400, 'Problems parsing JSON');
        const comment = createComment(repo, number, str(parsed.value?.body));
        if (comment === null) return error(404, 'Not Found');
        return json(201, { id: comment.id, body: comment.body, created_at: comment.createdAt, user: userJson(VIEWER_LOGIN) });
      }
      return error(404, 'Not Found');
    }
    if (b !== undefined) return error(404, 'Not Found');
    if (req.method === 'GET') {
      const issue = repo.issues.get(number);
      if (issue === undefined) return error(404, 'Not Found');
      return jsonBuffer(200, issueRestBuffer(repo, issue));
    }
    if (req.method === 'PATCH') {
      const parsed = parseJsonBody(req);
      if (parsed.malformed) return error(400, 'Problems parsing JSON');
      const issue = patchIssue(repo, number, {
        state: typeof parsed.value?.state === 'string' ? parsed.value.state : undefined,
        title: typeof parsed.value?.title === 'string' ? parsed.value.title : undefined,
        body: typeof parsed.value?.body === 'string' ? parsed.value.body : undefined,
      });
      if (issue === null) return error(404, 'Not Found');
      return jsonBuffer(200, issueRestBuffer(repo, issue));
    }
    return error(404, 'Not Found');
  }

  if (resource === 'labels') {
    if (a !== undefined) return error(404, 'Not Found');
    if (req.method === 'GET') {
      return json(200, [...repo.labels.values()].map((l) => ({ id: l.id, name: l.name, color: l.color, description: l.description })));
    }
    if (req.method === 'POST') {
      const parsed = parseJsonBody(req);
      if (parsed.malformed) return error(400, 'Problems parsing JSON');
      const name = str(parsed.value?.name);
      if (name === '') return error(422, 'name is required');
      const label = createLabel(repo, name, str(parsed.value?.color));
      return json(201, { id: label.id, name: label.name, color: label.color, description: label.description });
    }
    return error(404, 'Not Found');
  }

  if (resource === 'pulls') {
    if (a === undefined) {
      if (req.method === 'GET') {
        return json(200, listPulls(repo, req.query.get('state') ?? 'open').map((p) => pullRestJson(repo, p)));
      }
      if (req.method === 'POST') {
        const parsed = parseJsonBody(req);
        if (parsed.malformed) return error(400, 'Problems parsing JSON');
        const head = str(parsed.value?.head);
        const base = str(parsed.value?.base);
        const title = str(parsed.value?.title);
        if (head === '' || base === '' || title === '') return error(422, 'head, base and title are required');
        const pull = createPull(repo, { head, base, title, body: str(parsed.value?.body) });
        if ('error' in pull) return error(422, pull.error);
        return json(201, pullRestJson(repo, pull));
      }
      return error(404, 'Not Found');
    }
    const number = Number.parseInt(a, 10);
    if (!Number.isInteger(number)) return error(404, 'Not Found');
    const pull = repo.pulls.get(number);
    if (b === 'files') {
      if (req.method !== 'GET') return error(404, 'Not Found');
      if (pull === undefined) return error(404, 'Not Found');
      return json(200, pullFiles(repo, pull));
    }
    if (b === 'merge') {
      if (pull === undefined) return error(404, 'Not Found');
      if (req.method === 'GET') {
        return json(200, { mergeable: pullMergeable(repo, pull), state: pull.state, merged: pull.merged });
      }
      if (req.method === 'PUT') {
        const result = mergePull(repo, number);
        if ('error' in result) return error(result.status, result.error);
        return json(200, { merged: true, sha: result.sha, message: 'Pull Request successfully merged' });
      }
      return error(404, 'Not Found');
    }
    if (b !== undefined) return error(404, 'Not Found');
    if (req.method === 'GET') {
      if (pull === undefined) return error(404, 'Not Found');
      return json(200, pullRestJson(repo, pull));
    }
    return error(404, 'Not Found');
  }

  if (resource === 'branches') {
    if (a === undefined) {
      if (req.method === 'GET') {
        const out: Record<string, unknown>[] = [];
        for (const [ref, sha] of repo.refs) {
          if (!ref.startsWith('refs/heads/')) continue;
          out.push({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false });
        }
        out.sort((x, y) => String(x.name).localeCompare(String(y.name)));
        return json(200, out);
      }
      if (req.method === 'POST') {
        const parsed = parseJsonBody(req);
        if (parsed.malformed) return error(400, 'Problems parsing JSON');
        const branch = str(parsed.value?.branch);
        const sha = str(parsed.value?.sha);
        if (branch === '' || !isOid(sha)) return error(422, 'branch and a valid sha are required');
        if (repo.refs.has(`refs/heads/${branch}`)) return error(422, 'branch already exists');
        if (getObject(repo, sha) === undefined) return error(422, 'sha not found');
        repo.refs.set(`refs/heads/${branch}`, sha);
        repo.version += 1;
        return json(201, { name: branch, commit: { sha }, protected: false });
      }
      return error(404, 'Not Found');
    }
    return error(404, 'Not Found');
  }

  if (resource === 'commits') {
    if (a !== undefined) return error(404, 'Not Found');
    if (req.method !== 'GET') return error(404, 'Not Found');
    const sha = req.query.get('sha') ?? repo.defaultBranch;
    const tip = resolveRef(repo, sha) ?? (isOid(sha) ? sha : undefined);
    if (tip === undefined) return error(404, 'Not Found');
    const commits = listCommits(repo, tip).map((c) => ({
      sha: c.sha,
      commit: {
        message: c.message,
        author: { name: VIEWER_LOGIN, email: VIEWER_EMAIL },
        committer: { name: VIEWER_LOGIN, email: VIEWER_EMAIL },
      },
      html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${c.sha}`,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${c.sha}`,
    }));
    return json(200, commits);
  }

  if (resource === 'contents') {
    const path = tail.slice(1).map(decodeURIComponent).join('/');
    if (req.method === 'GET') {
      const result = readContent(repo, path, req.query.get('ref') ?? undefined);
      if (result === null) return error(404, 'Not Found');
      if ('file' in result) {
        const file = result.file;
        return json(200, {
          type: 'file',
          name: file.name,
          path: file.path,
          sha: file.sha,
          size: file.size,
          encoding: 'base64',
          content: b64encode(file.content),
          url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${file.path}`,
          html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${file.path}`,
          download_url: `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${repo.defaultBranch}/${file.path}`,
        });
      }
      return json(200, result.dir.map((entry) => ({
        type: entry.type,
        name: entry.name,
        path: entry.path,
        sha: entry.sha,
        size: entry.size ?? 0,
        url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${entry.path}`,
        html_url: `https://github.com/${repo.owner}/${repo.name}/${entry.type === 'dir' ? 'tree' : 'blob'}/${repo.defaultBranch}/${entry.path}`,
        download_url: entry.type === 'file' ? `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${repo.defaultBranch}/${entry.path}` : null,
      })));
    }
    if (req.method === 'PUT') {
      const parsed = parseJsonBody(req);
      if (parsed.malformed) return error(400, 'Problems parsing JSON');
      const content = str(parsed.value?.content);
      const message = str(parsed.value?.message);
      if (content === '' || message === '') return error(422, 'content and message are required');
      const result = putContent(repo, {
        path,
        contentB64: content,
        message,
        sha: typeof parsed.value?.sha === 'string' ? parsed.value.sha : undefined,
        branch: typeof parsed.value?.branch === 'string' ? parsed.value.branch : undefined,
      });
      if ('error' in result) return error(result.status, result.error);
      return json(201, {
        content: { type: 'file', name: path.split('/').pop()!, path, sha: result.contentSha, size: Buffer.from(content, 'base64').length, encoding: 'base64' },
        commit: { sha: result.commitSha, message },
      });
    }
    if (req.method === 'DELETE') {
      const parsed = parseJsonBody(req);
      if (parsed.malformed) return error(400, 'Problems parsing JSON');
      const sha = str(parsed.value?.sha);
      const message = str(parsed.value?.message);
      if (sha === '' || message === '') return error(422, 'sha and message are required');
      const result = deleteContent(repo, {
        path,
        message,
        sha,
        branch: typeof parsed.value?.branch === 'string' ? parsed.value.branch : undefined,
      });
      if ('error' in result) return error(result.status, result.error);
      return json(200, { commit: { sha: result.commitSha, message } });
    }
    return error(404, 'Not Found');
  }

  if (resource === 'git') {
    if (a === 'refs') {
      const refPath = tail.slice(2).join('/');
      if (req.method === 'GET') {
        if (refPath === '') {
          return json(200, listRefs(repo).map((r) => ({ ref: r.ref, object: { sha: r.sha, type: 'commit' }, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${r.ref}` })));
        }
        const fullRef = `refs/${refPath}`;
        const sha = repo.refs.get(fullRef);
        if (sha === undefined) return error(404, 'Not Found');
        return json(200, { ref: fullRef, object: { sha, type: 'commit' }, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${fullRef}` });
      }
      if (req.method === 'POST') {
        const parsed = parseJsonBody(req);
        if (parsed.malformed) return error(400, 'Problems parsing JSON');
        const ref = str(parsed.value?.ref);
        const sha = str(parsed.value?.sha);
        if (!ref.startsWith('refs/') || !isOid(sha)) return error(422, 'ref and a valid sha are required');
        if (repo.refs.has(ref)) return error(422, 'reference already exists');
        if (getObject(repo, sha) === undefined) return error(422, 'sha not found');
        repo.refs.set(ref, sha);
        repo.version += 1;
        return json(201, { ref, object: { sha, type: 'commit' }, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref}` });
      }
      return error(404, 'Not Found');
    }
    if (a === 'tags') {
      if (b !== undefined) {
        if (req.method !== 'GET') return error(404, 'Not Found');
        const object = getObject(repo, b);
        if (object === undefined || object.type !== 'tag') return error(404, 'Not Found');
        const tag = parseTag(object.data);
        return json(200, {
          sha: b,
          tag: tag.tag,
          message: tag.message,
          object: { sha: tag.object, type: tag.type },
          tagger: { name: VIEWER_LOGIN, email: VIEWER_EMAIL },
        });
      }
      if (req.method === 'POST') {
        const parsed = parseJsonBody(req);
        if (parsed.malformed) return error(400, 'Problems parsing JSON');
        const tagName = str(parsed.value?.tag);
        const message = str(parsed.value?.message);
        const objectSha = str(parsed.value?.object);
        const type = str(parsed.value?.type) as 'commit' | 'tree' | 'blob' | 'tag';
        if (tagName === '' || !isOid(objectSha) || !['commit', 'tree', 'blob', 'tag'].includes(type)) {
          return error(422, 'tag, message, object and type are required');
        }
        const target = getObject(repo, objectSha);
        if (target === undefined) return error(422, 'object not found');
        const identity = `${VIEWER_LOGIN} <${VIEWER_EMAIL}>`;
        const data = buildTag({ object: objectSha, type, tag: tagName, message, tagger: identity, timestamp: tick() });
        const sha = hashObject('tag', data);
        if (!repo.objects.has(sha)) repo.objects.set(sha, { type: 'tag', data });
        repo.version += 1;
        return json(201, { sha, tag: tagName, message, object: { sha: objectSha, type }, tagger: { name: VIEWER_LOGIN, email: VIEWER_EMAIL } });
      }
      return error(404, 'Not Found');
    }
    return error(404, 'Not Found');
  }

  return error(404, 'Not Found');
}

export { isOid, parseCommit, parseTree, type Pull, type Repo };
