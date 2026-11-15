import { isAncestor, peelToCommitWith, planFetch, readPack, writePack, type GitObject } from './objects.ts';
import { decodePackets, DELIM, FLUSH, packetLines, pktLine, pktLines } from './pkt.ts';
import { lookupOf, peelToCommit, type Repo } from './store.ts';
import { isOid, ZERO_OID } from './util.ts';

export interface HttpResult {
  status: number;
  headers?: Record<string, string>;
  body: Buffer;
}

function text(status: number, body: string, contentType = 'text/plain'): HttpResult {
  return { status, headers: { 'Content-Type': contentType }, body: Buffer.from(body, 'utf8') };
}

export function gitNotFound(message: string): HttpResult {
  return text(404, message);
}

const UPLOAD_PACK_SERVICE = 'git-upload-pack';
const RECEIVE_PACK_SERVICE = 'git-receive-pack';

const V2_CAPABILITIES: readonly string[] = [
  'ls-refs=unborn',
  'fetch=shallow filter',
  'object-format=sha1',
  'agent=github-core-clone/1.0.0',
];

function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** The v2 capability advertisement: `version 2` + one capability line each. */
function advertisementV2(repo: Repo): Buffer {
  const cached = (repo as unknown as { _adv2?: { version: number; body: Buffer } })._adv2;
  if (cached !== undefined && cached.version === repo.version) return cached.body;
  const lines: (string | 'flush')[] = ['version 2\n', ...V2_CAPABILITIES.map((cap) => `${cap}\n`), 'flush'];
  const body = Buffer.concat([pktLine(`# service=${UPLOAD_PACK_SERVICE}\n`), FLUSH, pktLines(lines)]);
  (repo as unknown as { _adv2?: { version: number; body: Buffer } })._adv2 = { version: repo.version, body };
  return body;
}

/** The v0 ref advertisement: a HEAD line first (carrying symref + capabilities), then every ref. */
function advertisementV0(repo: Repo, service: string): Buffer {
  const cached = (repo as unknown as { _adv0?: Map<string, { version: number; body: Buffer }> })._adv0?.get(service);
  if (cached !== undefined && cached.version === repo.version) return cached.body;
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const capabilities =
    service === UPLOAD_PACK_SERVICE
      ? `multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not deepen-relative no-progress include-tag multi_ack_detailed allow-tip-sha1-in-want allow-reachable-sha1-in-want no-done symref=HEAD:${defaultRef} object-format=sha1`
      : `report-status side-band-64k delete-refs object-format=sha1 symref=HEAD:${defaultRef}`;
  const lines: (string | 'flush')[] = [];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${capabilities}\n`);
  } else {
    const headOid = repo.refs.get(defaultRef) ?? ZERO_OID;
    lines.push(`${headOid} HEAD\0${capabilities}\n`);
    for (const [name, oid] of refs) {
      lines.push(`${oid} ${name}\n`);
      if (name.startsWith('refs/tags/')) {
        const obj = repo.objects.get(oid);
        if (obj !== undefined && obj.type === 'tag') {
          const target = peelToCommit(repo, oid);
          if (target !== null) lines.push(`${target} ${name}^{}\n`);
        }
      }
    }
  }
  lines.push('flush');
  const body = Buffer.concat([pktLine(`# service=${service}\n`), FLUSH, pktLines(lines)]);
  const store = (repo as unknown as { _adv0?: Map<string, { version: number; body: Buffer }> });
  if (store._adv0 === undefined) store._adv0 = new Map();
  store._adv0.set(service, { version: repo.version, body });
  return body;
}

/** GET /{owner}/{repo}.git/info/refs?service=... — v2 when the Git-Protocol header asks for it. */
export function infoRefs(repo: Repo, service: string, gitProtocol?: string): HttpResult {
  if (service !== UPLOAD_PACK_SERVICE && service !== RECEIVE_PACK_SERVICE) {
    return text(400, `unsupported service ${service}`);
  }
  // Receive-pack is v0-only; upload-pack answers v2 when the client asks for it.
  if (service === UPLOAD_PACK_SERVICE && gitProtocol === 'version=2') {
    return {
      status: 200,
      headers: { 'Content-Type': `application/x-${UPLOAD_PACK_SERVICE}-advertisement` },
      body: advertisementV2(repo),
    };
  }
  return {
    status: 200,
    headers: { 'Content-Type': `application/x-${service}-advertisement` },
    body: advertisementV0(repo, service),
  };
}

// ---------------------------------------------------------------------------------------------
// upload-pack v2 (fetch / ls-refs)
// ---------------------------------------------------------------------------------------------

export interface FetchRequest {
  wants: string[];
  haves: string[];
  depth: number | undefined;
  filter: string | undefined;
  shallow: string[];
  /** The client sent `done` (negotiation closed). Real git's pull omits it when it has haves. */
  done: boolean;
}

interface UploadPackError {
  kind: 'error';
  message: string;
}

interface UploadPackLsRefs {
  kind: 'ls-refs';
  unborn: boolean;
  peel: boolean;
  symrefs: boolean;
  prefixes: string[];
}

interface UploadPackFetch {
  kind: 'fetch';
  request: FetchRequest;
}

function parseUploadPackRequest(packets: ReturnType<typeof decodePackets>['packets']): UploadPackError | UploadPackLsRefs | UploadPackFetch {
  // pkt-line payloads carry a trailing newline; strip it before comparing commands.
  const lines = packetLines(packets).map((line) => line.replace(/\r?\n$/, ''));
  if (lines.length === 0) return { kind: 'error', message: 'empty upload-pack request' };
  const first = lines[0]!;
  const command = first.split(' ')[0]!;
  if (command === 'command=ls-refs') {
    const args = lines.slice(1);
    const prefixes: string[] = [];
    for (const arg of args) {
      if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length).trim());
    }
    return {
      kind: 'ls-refs',
      unborn: args.includes('unborn'),
      peel: args.includes('peel'),
      symrefs: args.includes('symrefs'),
      prefixes,
    };
  }
  if (command === 'command=fetch') {
    const request: FetchRequest = { wants: [], haves: [], depth: undefined, filter: undefined, shallow: [], done: false };
    for (const line of lines.slice(1)) {
      if (line === 'done') { request.done = true; continue; }
      if (line === '') continue;
      if (line.startsWith('want ')) {
        const oid = line.slice(5).trim();
        if (isOid(oid)) request.wants.push(oid);
      } else if (line.startsWith('have ')) {
        const oid = line.slice(5).trim();
        if (isOid(oid)) request.haves.push(oid);
      } else if (line.startsWith('deepen ')) {
        // v2 fetch: `deepen N` is the depth limit.
        const value = Number.parseInt(line.slice(7).trim(), 10);
        if (Number.isFinite(value) && value > 0) request.depth = value;
      } else if (line.startsWith('depth ')) {
        const value = Number.parseInt(line.slice(6).trim(), 10);
        if (Number.isFinite(value) && value > 0) request.depth = value;
      } else if (line.startsWith('filter ')) {
        request.filter = line.slice(7).trim();
      } else if (line.startsWith('shallow ')) {
        const oid = line.slice(8).trim();
        if (isOid(oid)) request.shallow.push(oid);
      }
    }
    return { kind: 'fetch', request };
  }
  return { kind: 'error', message: `unsupported upload-pack command ${command}` };
}

function lsRefsResponse(repo: Repo, opts: { peel: boolean; symrefs: boolean; prefixes: string[]; unborn: boolean }): Buffer {
  const cacheKey = `lsrefs:${repo.version}:${opts.peel}:${opts.symrefs}:${opts.prefixes.join(',')}:${opts.unborn}`;
  const cached = (repo as unknown as { _ls?: Map<string, Buffer> })._ls?.get(cacheKey);
  if (cached !== undefined) return cached;
  const keep = (name: string): boolean => opts.prefixes.length === 0 || opts.prefixes.some((prefix) => name.startsWith(prefix));
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(defaultRef);
  const lines: (string | 'flush')[] = [];
  if (opts.symrefs && headOid !== undefined && keep('HEAD')) {
    lines.push(`${headOid} HEAD symref-target:${defaultRef}\n`);
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!keep(name)) continue;
    let line = `${oid} ${name}`;
    if (opts.peel) {
      const obj = repo.objects.get(oid);
      if (obj !== undefined && obj.type === 'tag') {
        const target = peelToCommit(repo, oid);
        if (target !== null) line += ` peeled:${target}`;
      }
    }
    lines.push(`${line}\n`);
  }
  if (repo.refs.size === 0 && opts.unborn && keep('HEAD')) {
    lines.push(`unborn HEAD symref-target:${defaultRef}\n`);
  }
  lines.push('flush');
  const body = pktLines(lines);
  const store = (repo as unknown as { _ls?: Map<string, Buffer> });
  if (store._ls === undefined) store._ls = new Map();
  if (store._ls.size > 64) store._ls.clear();
  store._ls.set(cacheKey, body);
  return body;
}

function fetchResponse(repo: Repo, request: FetchRequest): Buffer {
  // Negotiation (real git's pull sends haves WITHOUT `done`): the server must answer with an
  // acknowledgments section first. Verified against `git upload-pack --stateless-rpc`:
  //   - at least one known have  -> `ACK <oid>` per known have, then `ready`, delim, packfile.
  //   - no known have            -> `NAK` + flush, NO packfile (client retries with `done`).
  //   - `done` present, or no haves -> no acknowledgments section at all, just the packfile.
  // (The kit always sends `done`, so its fetches take the no-acknowledgments path.)
  let acks: string[] = [];
  if (request.haves.length > 0 && !request.done) {
    for (const have of request.haves) {
      if (repo.objects.has(have)) acks.push(have);
    }
    if (acks.length === 0) {
      return pktLines(['acknowledgments\n', 'NAK\n', 'flush']);
    }
  }
  const cacheKey = `pack:${request.wants.slice().sort().join(',')}|${request.haves.slice().sort().join(',')}|${request.depth ?? ''}|${request.shallow.slice().sort().join(',')}|${request.done ? 'd' : ''}`;
  const cached = repo.packCache.get(cacheKey);
  if (cached !== undefined) return cached.encoded;
  const plan = planFetch(request.wants, request.haves, request.depth, request.shallow, lookupOf(repo));
  const pack = writePack(plan.objects);
  const encoded = encodeFetchResponse(repo, request.wants, pack, plan.shallow, plan.unshallow, acks);
  if (repo.packCache.size >= 128) {
    const first = repo.packCache.keys().next();
    if (!first.done) repo.packCache.delete(first.value);
  }
  repo.packCache.set(cacheKey, { pack, shallow: plan.shallow, unshallow: plan.unshallow, encoded });
  return encoded;
}

function encodeFetchResponse(repo: Repo, wants: readonly string[], pack: Buffer, shallow: string[], unshallow: string[], acks: readonly string[] = []): Buffer {
  // Matches real git's upload-pack --stateless-rpc v2 response, verified byte-for-byte:
  // NO acknowledgments section when `done` was sent or there are no haves (git's client expects
  // the response to start with shallow-info/packfile and dies "expected 'packfile'" otherwise),
  // NO wanted-refs section, and shallow-info ONLY when there are shallow/unshallow lines.
  // When haves arrived without `done`, the acknowledgments section (ACKs + ready + delim) comes first.
  const sections: Buffer[] = [];
  if (acks.length > 0) {
    const ackLines: (string | 'delim')[] = ['acknowledgments\n'];
    for (const ack of acks) ackLines.push(`ACK ${ack}\n`);
    ackLines.push('ready\n');
    ackLines.push('delim');
    sections.push(pktLines(ackLines));
  }
  if (shallow.length > 0 || unshallow.length > 0) {
    const shallowLines: (string | Buffer | 'delim')[] = [];
    for (const oid of shallow) shallowLines.push(`shallow ${oid}\n`);
    for (const oid of unshallow) shallowLines.push(`unshallow ${oid}\n`);
    sections.push(pktLines(['shallow-info\n', ...shallowLines, 'delim']));
  }
  void wants;
  // packfile (only when there is something to send), chunked into side-band-64k packets
  // of at most 65520 bytes including the pkt-line header, each starting with band byte 1.
  // The section's trailing flush IS the end of the response — real git's upload-pack sends
  // nothing after it (no second flush, no 0002); an extra flush makes the client die
  // "expected response end packet".
  if (pack.length > 0) {
    const packets: Buffer[] = [pktLine('packfile\n')];
    const CHUNK = 65515;
    for (let offset = 0; offset < pack.length; offset += CHUNK) {
      const chunk = pack.subarray(offset, offset + CHUNK);
      const framed = Buffer.allocUnsafe(chunk.length + 1);
      framed[0] = 1;
      chunk.copy(framed, 1);
      packets.push(pktLine(framed));
    }
    packets.push(FLUSH);
    sections.push(Buffer.concat(packets));
  }
  return Buffer.concat(sections);
}

function uploadPackError(message: string): Buffer {
  return pktLines([`ERR ${message}\n`, 'flush']);
}

/** POST /{owner}/{repo}.git/git-upload-pack */
export function handleUploadPack(repo: Repo, body: Buffer): HttpResult {
  const decoded = decodePackets(body);
  const request = parseUploadPackRequest(decoded.packets);
  if (request.kind === 'error') {
    return { status: 200, headers: { 'Content-Type': 'application/x-git-upload-pack-result' }, body: uploadPackError(request.message) };
  }
  if (request.kind === 'ls-refs') {
    return {
      status: 200,
      headers: { 'Content-Type': 'application/x-git-upload-pack-result' },
      body: lsRefsResponse(repo, request),
    };
  }
  // fetch: validate wants exist.
  for (const want of request.request.wants) {
    if (repo.objects.get(want) === undefined) {
      return { status: 200, headers: { 'Content-Type': 'application/x-git-upload-pack-result' }, body: uploadPackError(`want ${want} not found`) };
    }
  }
  return {
    status: 200,
    headers: { 'Content-Type': 'application/x-git-upload-pack-result' },
    body: fetchResponse(repo, request.request),
  };
}

// ---------------------------------------------------------------------------------------------
// receive-pack v0 (push)
// ---------------------------------------------------------------------------------------------

interface ReceivePackRequest {
  refs: Array<{ oldOid: string; newOid: string; name: string }>;
  commands: string[];
  pack: Buffer;
}

function parseReceivePackRequest(body: Buffer): ReceivePackRequest | null {
  const decoded = decodePackets(body);
  const refs: ReceivePackRequest['refs'] = [];
  const commands: string[] = [];
  for (const line of packetLines(decoded.packets)) {
    const parts = line.trim().split(' ');
    if (parts.length >= 3) {
      const [oldOid, newOid, rawName] = parts;
      // The first ref line carries the negotiated capabilities after a NUL
      // ("refs/heads/main\0report-status side-band-64k"); the ref name is before it.
      const name = rawName!.split('\0')[0]!;
      if (isOid(oldOid!) && isOid(newOid!) && name.startsWith('refs/')) {
        refs.push({ oldOid: oldOid!, newOid: newOid!, name });
        continue;
      }
    }
    commands.push(line);
  }
  return { refs, commands, pack: decoded.trailing };
}

function reportStatus(results: Array<{ name: string; status: 'ok' | 'ng'; reason?: string }>): Buffer {
  // Real git's receive-pack wraps the WHOLE pkt-line-framed report (lines + trailing flush)
  // inside band-1 sideband packets, then a final flush — verified byte-for-byte against
  // `git receive-pack --stateless-rpc`. The client feeds the band-1 data to a pkt-line reader,
  // so raw text lines inside band 1 make it die "bad line length character: unpa".
  // (The kit's parsePushReport accepts both shapes; this is the real-git shape.)
  const lines: Buffer[] = [pktLine('unpack ok\n')];
  for (const result of results) {
    lines.push(pktLine(result.status === 'ok' ? `ok ${result.name}\n` : `ng ${result.name} ${result.reason ?? 'failed'}\n`));
  }
  lines.push(FLUSH);
  const inner = Buffer.concat(lines);
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < inner.length; offset += CHUNK) {
    const chunk = inner.subarray(offset, offset + CHUNK);
    const framed = Buffer.allocUnsafe(chunk.length + 1);
    framed[0] = 1;
    chunk.copy(framed, 1);
    parts.push(pktLine(framed));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** POST /{owner}/{repo}.git/git-receive-pack */
export function handleReceivePack(repo: Repo, body: Buffer): HttpResult {
  const request = parseReceivePackRequest(body);
  if (request === null) {
    return { status: 200, headers: { 'Content-Type': 'application/x-git-receive-pack-result' }, body: reportStatus([]) };
  }
  let objects: Map<string, GitObject> = new Map();
  if (request.pack.length > 0) {
    try {
      const read = readPack(request.pack, lookupOf(repo));
      objects = read.objects;
    } catch (error) {
      return {
        status: 200,
        headers: { 'Content-Type': 'application/x-git-receive-pack-result' },
        body: reportStatus(request.refs.map((r) => ({ name: r.name, status: 'ng' as const, reason: 'unpack failed' }))),
      };
    }
  }
  // Store the pack objects first: every valid ref update below needs them.
  for (const [oid, object] of objects) {
    if (!repo.objects.has(oid)) {
      repo.objects.set(oid, object);
      if (object.type === 'commit') repo.commitSeq.set(oid, repo.nextCommitSeq++);
    }
  }
  // Each ref update is validated and applied on its own: a rejected ref (non-fast-forward,
  // stale old value, missing object) does not block the valid updates in the same push.
  const lookup = lookupOf(repo);
  const results: Array<{ name: string; status: 'ok' | 'ng'; reason?: string }> = [];
  let applied = false;
  for (const ref of request.refs) {
    const current = repo.refs.get(ref.name);
    if (ref.newOid === '0'.repeat(40)) {
      // delete
      if (current === undefined) {
        results.push({ name: ref.name, status: 'ng', reason: 'ref does not exist' });
        continue;
      }
      repo.refs.delete(ref.name);
      applied = true;
      results.push({ name: ref.name, status: 'ok' });
      continue;
    }
    const target = repo.objects.get(ref.newOid);
    if (target === undefined) {
      results.push({ name: ref.name, status: 'ng', reason: 'object not found' });
      continue;
    }
    if (current !== undefined) {
      if (current !== ref.oldOid) {
        results.push({ name: ref.name, status: 'ng', reason: 'old value mismatch' });
        continue;
      }
      // Fast-forward: the new commit must descend from the old one.
      const oldCommit = peelToCommitWith(lookup, current);
      const newCommit = peelToCommitWith(lookup, ref.newOid);
      if (oldCommit !== null && newCommit !== null && !isAncestor(oldCommit, newCommit, lookup)) {
        results.push({ name: ref.name, status: 'ng', reason: 'non-fast-forward' });
        continue;
      }
    }
    repo.refs.set(ref.name, ref.newOid);
    applied = true;
    results.push({ name: ref.name, status: 'ok' });
  }
  if (applied) repo.version += 1;
  return { status: 200, headers: { 'Content-Type': 'application/x-git-receive-pack-result' }, body: reportStatus(results) };
}

// ---------------------------------------------------------------------------------------------
// helpers shared with the REST layer
// ---------------------------------------------------------------------------------------------

/** The ref list for a repo: HEAD + every ref (peel tags), newest-first by seq is the caller's job. */
export function listRefs(repo: Repo): Array<{ ref: string; sha: string }> {
  const out: Array<{ ref: string; sha: string }> = [];
  for (const [name, oid] of repo.refs) out.push({ ref: name, sha: oid });
  out.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  return out;
}
