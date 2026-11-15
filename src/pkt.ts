/** pkt-line framing for git smart HTTP. */

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');
export const RESPONSE_END = Buffer.from('0002', 'ascii');

const HEX = '0123456789abcdef';

/** Encode one data packet: 4 hex length bytes + payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  const head = Buffer.allocUnsafe(4);
  head[0] = HEX[(len >> 12) & 0xf]!.charCodeAt(0);
  head[1] = HEX[(len >> 8) & 0xf]!.charCodeAt(0);
  head[2] = HEX[(len >> 4) & 0xf]!.charCodeAt(0);
  head[3] = HEX[len & 0xf]!.charCodeAt(0);
  return Buffer.concat([head, data]);
}

/** Encode a sequence of data packets / flush / delim / response-end markers. */
export function pktLines(items: ReadonlyArray<string | Buffer | 'flush' | 'delim' | 'response-end'>): Buffer {
  const parts: Buffer[] = new Array(items.length);
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]!;
    if (item === 'flush') parts[i] = FLUSH;
    else if (item === 'delim') parts[i] = DELIM;
    else if (item === 'response-end') parts[i] = RESPONSE_END;
    else parts[i] = pktLine(item);
  }
  return Buffer.concat(parts);
}

export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/**
 * Decode a whole buffer into packets. Returns the packets plus any trailing raw bytes
 * (a pack follows the flush in receive-pack bodies).
 */
export function decodePackets(buf: Buffer): { packets: Packet[]; trailing: Buffer } {
  const packets: Packet[] = [];
  let offset = 0;
  const len = buf.length;
  while (offset + 4 <= len) {
    const h0 = buf[offset]!;
    const h1 = buf[offset + 1]!;
    const h2 = buf[offset + 2]!;
    const h3 = buf[offset + 3]!;
    const isHex = (c: number): boolean =>
      (c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70);
    if (!isHex(h0) || !isHex(h1) || !isHex(h2) || !isHex(h3)) break;
    const hexVal = (c: number): number => (c <= 57 ? c - 48 : (c | 32) - 87);
    const length = (hexVal(h0) << 12) | (hexVal(h1) << 8) | (hexVal(h2) << 4) | hexVal(h3);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > len) break;
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, trailing: buf.subarray(offset) };
}

/** The data-packet payloads as strings, control packets dropped. */
export function packetLines(packets: readonly Packet[]): string[] {
  const out: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') out.push(packet.payload.toString('utf8'));
  }
  return out;
}
