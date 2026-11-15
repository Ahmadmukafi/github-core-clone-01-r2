import { createHash } from 'node:crypto';

/** The scenario's fixed epoch: the base of every timestamp this forge emits. */
export const EPOCH_SEC = 1735689600;

/** The login the shop token names (the scenario viewer; the kit's seed is fixed). */
export const VIEWER_LOGIN = process.env.MAKEFUN_VIEWER_LOGIN ?? 'adaiversen';
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const VIEWER_ID = 1000;

/** A deterministic logical clock: one tick per creation event, never the wall clock. */
let tickCount = 0;
export function tick(): number {
  tickCount += 1;
  return EPOCH_SEC + tickCount;
}

export function isoOf(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** SHA-1 hex of a buffer. */
export function sha1Hex(data: Uint8Array): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The git object id: SHA-1 over `<type> <size>\0` + bytes. */
export function hashObject(type: string, data: Buffer): string {
  const h = createHash('sha1');
  h.update(`${type} ${data.length}\0`, 'utf8');
  h.update(data);
  return h.digest('hex');
}

export const ZERO_OID = '0'.repeat(40);
const HEX40 = /^[0-9a-f]{40}$/;
export function isOid(value: unknown): value is string {
  return typeof value === 'string' && HEX40.test(value);
}

/** Standard base64 of UTF-8 text. */
export function b64encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

export function b64decode(content: string): Buffer {
  return Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64');
}

/** URL-safe base64 without padding (Relay global ids, cursors). */
export function b64urlEncode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

export function b64urlDecode(value: string): string | null {
  try {
    return Buffer.from(value, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

/** Opaque Relay global id: base64url of `Type:parts...`. */
export function globalId(type: string, ...parts: Array<string | number>): string {
  return b64urlEncode([type, ...parts].join(':'));
}

export function parseGlobalId(id: string): { type: string; parts: string[] } | null {
  const text = b64urlDecode(id);
  if (text === null) return null;
  const parts = text.split(':');
  const type = parts.shift();
  if (type === undefined || parts.length === 0) return null;
  return { type, parts };
}

/** A monotonic request id for X-GitHub-Request-Id. */
let requestSeq = 0;
export function nextRequestId(): string {
  requestSeq += 1;
  return `req-${requestSeq.toString(36)}${(requestSeq * 2654435761 % 46656).toString(36)}`;
}

/** JSON stringify that never throws on our own shapes. */
export function jsonString(value: unknown): string {
  return JSON.stringify(value) ?? 'null';
}
