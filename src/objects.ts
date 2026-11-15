import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { hashObject, isOid } from './util.ts';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export type ObjectLookup = (oid: string) => GitObject | undefined;

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object into entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  const len = data.length;
  while (offset < len) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > len) break;
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree sort: byte order, a directory compared as if its name ended in '/'. */
export function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = a.mode === '40000' ? `${a.name}/` : a.name;
  const right = b.mode === '40000' ? `${b.name}/` : b.name;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** Build a tree object from entries (sorted git's way). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = new Array(sorted.length * 2);
  let i = 0;
  for (const entry of sorted) {
    parts[i++] = Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8');
    parts[i++] = Buffer.from(entry.oid, 'hex');
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object. Fast path: scan header lines for tree/parent/author/committer. */
export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  let start = 0;
  while (start < headerEnd) {
    let end = data.indexOf(0x0a, start);
    if (end < 0 || end > headerEnd) end = headerEnd;
    const line = data.subarray(start, end).toString('utf8');
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
    start = end + 1;
  }
  return { tree, parents, author, committer, message };
}

export function peelToCommitWith(lookup: ObjectLookup, oid: string): string | null {
  let current = oid;
  for (let i = 0; i < 10; i += 1) {
    const obj = lookup(current);
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

export interface TagView {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let object = '';
  let type: GitObjectType = 'commit';
  let tag = '';
  let tagger = '';
  let start = 0;
  while (start < headerEnd) {
    let end = data.indexOf(0x0a, start);
    if (end < 0 || end > headerEnd) end = headerEnd;
    const line = data.subarray(start, end).toString('utf8');
    if (line.startsWith('object ')) object = line.slice(7);
    else if (line.startsWith('type ')) type = line.slice(5) as GitObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
    start = end + 1;
  }
  return { object, type, tag, tagger, message };
}

export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}): Buffer {
  const stamp = `${fields.timestamp} +0000`;
  let out = `tree ${fields.tree}\n`;
  for (const parent of fields.parents ?? []) out += `parent ${parent}\n`;
  out += `author ${fields.author} ${stamp}\ncommitter ${fields.committer} ${stamp}\n\n${fields.message}`;
  return Buffer.from(out, 'utf8');
}

export function buildTag(fields: {
  object: string;
  type: GitObjectType;
  tag: string;
  message: string;
  tagger: string;
  timestamp: number;
}): Buffer {
  const stamp = `${fields.timestamp} +0000`;
  return Buffer.from(
    `object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${fields.tagger} ${stamp}\n\n${fields.message}`,
    'utf8',
  );
}

/** Flatten a tree to path -> {oid, mode}, recursively. */
export function flattenTree(rootOid: string, lookup: ObjectLookup, out: Map<string, { oid: string; mode: string }>): void {
  const stack: Array<{ oid: string; prefix: string }> = [{ oid: rootOid, prefix: '' }];
  while (stack.length > 0) {
    const { oid, prefix } = stack.pop()!;
    const obj = lookup(oid);
    if (obj === undefined || obj.type !== 'tree') continue;
    for (const entry of parseTree(obj.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') stack.push({ oid: entry.oid, prefix: path });
      else if (entry.mode !== '160000') out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  }
}

export interface TreeDiffEntry {
  path: string;
  oldOid: string | null;
  newOid: string | null;
  oldMode: string | null;
  newMode: string | null;
}

/** Diff two trees (by root oid): one entry per path that differs. */
export function diffTrees(baseRoot: string | null, headRoot: string, lookup: ObjectLookup): TreeDiffEntry[] {
  const base = new Map<string, { oid: string; mode: string }>();
  const head = new Map<string, { oid: string; mode: string }>();
  if (baseRoot !== null) flattenTree(baseRoot, lookup, base);
  flattenTree(headRoot, lookup, head);
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  const out: TreeDiffEntry[] = [];
  for (const path of paths) {
    const b = base.get(path);
    const h = head.get(path);
    if (b !== undefined && h !== undefined && b.oid === h.oid) continue;
    out.push({
      path,
      oldOid: b?.oid ?? null,
      newOid: h?.oid ?? null,
      oldMode: b?.mode ?? null,
      newMode: h?.mode ?? null,
    });
  }
  out.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  return out;
}

/** The nearest common ancestor of two commits (first found by BFS from b over a's ancestor set). */
export function mergeBase(a: string, b: string, lookup: ObjectLookup): string | null {
  const ancestorsA = new Set<string>();
  const queueA: string[] = [a];
  while (queueA.length > 0) {
    const oid = queueA.pop()!;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    const obj = lookup(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queueA.push(parent);
  }
  const queueB: string[] = [b];
  const seenB = new Set<string>();
  while (queueB.length > 0) {
    const oid = queueB.shift()!;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const obj = lookup(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queueB.push(parent);
  }
  return null;
}

/** True when `descendant` is `ancestor` or has it among its commit ancestors. */
export function isAncestor(ancestor: string, descendant: string, lookup: ObjectLookup): boolean {
  if (ancestor === descendant) return true;
  const queue: string[] = [descendant];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = lookup(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// packfile write (plain objects, zlib level 1 for speed)
// ---------------------------------------------------------------------------------------------

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a version-2 pack from plain objects. Objects are packed in the given order. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = new Array(objects.length * 2 + 1);
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts[0] = header;
  let i = 1;
  for (const object of objects) {
    parts[i++] = writePackObjectHeader(object.type, object.data.length);
    parts[i++] = deflateSync(object.data, { level: 1 });
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------------------------------------
// packfile read (plain + OFS/REF deltas)
// ---------------------------------------------------------------------------------------------

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++]!;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start]!;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++]!;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function inflateAt(buffer: Buffer, offset: number, end: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset, end);
  const result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++]!;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++]! * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++]! * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

export interface PackReadResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/** Read a packfile, resolving OFS_DELTA/REF_DELTA entries. `resolveBase` supplies thin-pack bases. */
export function readPack(pack: Buffer, resolveBase?: ObjectLookup): PackReadResult {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;

  interface Raw {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: GitObjectType;
    resolved?: Buffer;
    oid?: string;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack, offset, trailerStart);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, Raw>();
  const resolving = new Set<number>();
  let deltaCount = 0;
  const resolve = (entry: Raw): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved !== undefined && entry.resolvedType !== undefined && entry.oid !== undefined) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (baseEntry === undefined) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const baseEntry = resolvedByOid.get(entry.baseOid!);
      if (baseEntry !== undefined) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(entry.baseOid!);
        if (external === undefined) throw new Error(`ref-delta base ${entry.baseOid} is neither in the pack nor supplied`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode]!;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (entry.typeCode === 6 || entry.typeCode === 7) deltaCount += 1;
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return { objects, deltaCount };
}

// ---------------------------------------------------------------------------------------------
// fetch planning: which objects a fetch sends
// ---------------------------------------------------------------------------------------------

export interface FetchPlan {
  /** Objects to pack, in deterministic (oid-sorted) order. */
  objects: GitObject[];
  /** The new shallow boundary after this fetch. */
  shallow: string[];
  /** Old shallow boundaries that are no longer shallow. */
  unshallow: string[];
}

/**
 * Plan a fetch: wants, haves the client already holds, an optional depth limit and the client's
 * current shallow boundaries. Objects reachable from a have are excluded; a shallow boundary stops
 * the have-walk (its parents are not held). Commits are included up to `depth` generations from a
 * want (depth 1 = the wants themselves); every included commit contributes its whole tree.
 */
export function planFetch(
  wants: readonly string[],
  haves: readonly string[],
  depth: number | undefined,
  oldShallow: readonly string[],
  lookup: ObjectLookup,
): FetchPlan {
  const oldShallowSet = new Set(oldShallow);
  // 1. The have set: everything reachable from a have, stopping at shallow boundaries.
  const haveObjects = new Set<string>();
  const haveQueue: string[] = [...haves];
  while (haveQueue.length > 0) {
    const oid = haveQueue.pop()!;
    if (haveObjects.has(oid) || !isOid(oid)) continue;
    const obj = lookup(oid);
    if (obj === undefined) continue;
    haveObjects.add(oid);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      addTreeObjects(commit.tree, lookup, haveObjects);
      if (!oldShallowSet.has(oid)) {
        for (const parent of commit.parents) haveQueue.push(parent);
      }
    } else if (obj.type === 'tag') {
      haveQueue.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      addTreeObjects(oid, lookup, haveObjects);
    }
  }

  // 2. BFS from the wants over commits, tracking distance; tags peel to their target at distance 0.
  const maxDist = depth === undefined ? Infinity : depth - 1;
  const commitDist = new Map<string, number>();
  const queue: Array<{ oid: string; dist: number }> = [];
  for (const want of wants) {
    if (!isOid(want)) continue;
    const obj = lookup(want);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      const target = parseTag(obj.data).object;
      queue.push({ oid: target, dist: 0 });
    } else if (obj.type === 'commit') {
      queue.push({ oid: want, dist: 0 });
    }
  }
  // Deterministic order: process in oid order at each level.
  queue.sort((a, b) => (a.oid < b.oid ? -1 : 1));
  const included = new Set<string>();
  const includedCommits: Array<{ oid: string; dist: number }> = [];
  while (queue.length > 0) {
    const { oid, dist } = queue.shift()!;
    if (commitDist.has(oid) || dist > maxDist) continue;
    commitDist.set(oid, dist);
    included.add(oid);
    includedCommits.push({ oid, dist });
    const obj = lookup(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (!commitDist.has(parent)) queue.push({ oid: parent, dist: dist + 1 });
    }
  }

  // 3. Trees + blobs of every included commit, plus tag objects for tag wants.
  for (const want of wants) {
    const obj = lookup(want);
    if (obj !== undefined && obj.type === 'tag') included.add(want);
  }
  for (const { oid } of includedCommits) {
    const obj = lookup(oid);
    if (obj === undefined) continue;
    addTreeObjects(parseCommit(obj.data).tree, lookup, included);
  }

  // 4. Subtract what the client holds.
  for (const oid of haveObjects) included.delete(oid);

  // 5. Shallow bookkeeping.
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== undefined) {
    for (const { oid, dist } of includedCommits) {
      if (dist !== maxDist) continue;
      const obj = lookup(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      if (parents.some((p) => !included.has(p) && !haveObjects.has(p))) shallow.push(oid);
    }
    for (const boundary of oldShallow) {
      const obj = lookup(boundary);
      if (obj === undefined || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      if (parents.length === 0 || parents.every((p) => included.has(p) || haveObjects.has(p))) {
        if (!shallow.includes(boundary)) unshallow.push(boundary);
      } else if (!shallow.includes(boundary)) {
        shallow.push(boundary);
      }
    }
  }

  const oids = [...included].sort();
  const objects: GitObject[] = [];
  for (const oid of oids) {
    const obj = lookup(oid);
    if (obj !== undefined) objects.push(obj);
  }
  return { objects, shallow: shallow.sort(), unshallow: unshallow.sort() };
}

/** Add a tree and everything under it to `out` (gitlinks skipped). */
export function addTreeObjects(rootOid: string, lookup: ObjectLookup, out: Set<string>): void {
  const stack: string[] = [rootOid];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (out.has(oid)) continue;
    const obj = lookup(oid);
    if (obj === undefined) continue;
    out.add(oid);
    if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) {
        if (entry.mode === '160000') continue;
        stack.push(entry.oid);
      }
    }
  }
}

/** Every object reachable from `roots` (commits, tags, trees, blobs). */
export function collectReachable(roots: Iterable<string>, lookup: ObjectLookup): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isOid(root)) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = lookup(oid);
    if (obj === undefined) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (obj.type === 'tag') {
      queue.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return seen;
}
