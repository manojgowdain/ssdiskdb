/**
 * Record Codec
 *
 * Every data record stored in LevelDB is wrapped in a small binary envelope so
 * that TTL metadata can live beside the payload without an extra LevelDB read
 * on the GET hot path.
 *
 * Format (v1):
 *
 *   [flags: 1 byte][expiresAt: 8 bytes BE][payload]
 *
 *   flags = 0  -> no expiration (payload follows immediately)
 *   flags = 1  -> expiresAt present (uint64 BE, milliseconds since epoch)
 *
 * Legacy records (written before TTL support) are raw JSON strings and start
 * with a JSON structural character (`{`, `[`, `"`, `t`, `f`, `n`, `-`, digit).
 * None of those equal the control bytes 0x00 / 0x01, so legacy records are
 * detected unambiguously and remain readable forever. No migration required.
 */

export const RECORD_VERSION = 1;
export const FLAG_NO_TTL = 0;
export const FLAG_HAS_TTL = 1;

export function encodeRecord(payload: Buffer, expiresAt?: number): Buffer {
  if (expiresAt == null) {
    const buf = Buffer.alloc(1 + payload.length);
    buf[0] = FLAG_NO_TTL;
    payload.copy(buf, 1);
    return buf;
  }
  const buf = Buffer.alloc(9 + payload.length);
  buf[0] = FLAG_HAS_TTL;
  buf.writeBigUInt64BE(BigInt(Math.floor(expiresAt)), 1);
  payload.copy(buf, 9);
  return buf;
}

export interface DecodedRecord {
  payload: Buffer;
  expiresAt?: number;
  version: number;
}

export function decodeRecord(raw: Buffer): DecodedRecord {
  if (raw.length === 0) return { payload: raw, version: RECORD_VERSION };
  const flag = raw[0];
  if (flag === FLAG_HAS_TTL) {
    if (raw.length < 9) {
      // Corrupt/truncated record: fall back to treating the whole buffer as payload.
      return { payload: raw, version: RECORD_VERSION };
    }
    const expiresAt = Number(raw.readBigUInt64BE(1));
    return { payload: raw.subarray(9), expiresAt, version: RECORD_VERSION };
  }
  if (flag === FLAG_NO_TTL) {
    return { payload: raw.subarray(1), version: RECORD_VERSION };
  }
  // Anything else is a legacy JSON record.
  return { payload: raw, version: 0 };
}

/** True when the buffer is a pre-TTL legacy JSON record. */
export function isLegacyRecord(raw: Buffer): boolean {
  return raw.length > 0 && raw[0] !== FLAG_NO_TTL && raw[0] !== FLAG_HAS_TTL;
}
import { Buffer } from "node:buffer";

