import { randomBytes } from "node:crypto";

/**
 * UUIDv7 (RFC 9562): a millisecond timestamp followed by random bits. IDs sort by creation
 * time, which keeps B-tree indexes compact. Postgres 17 has no built-in uuidv7(), so the app
 * generates them.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  // 48-bit big-endian timestamp. Division instead of bit shifts: shifts truncate to 32 bits.
  let ts = now;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ts % 256;
    ts = Math.floor(ts / 256);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70; // version 7
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // RFC 9562 variant
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
