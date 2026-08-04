import { randomBytes } from "node:crypto";

/**
 * UUIDv7: time-ordered UUID (48-bit millisecond timestamp + random tail).
 * Used for high-volume append-only rows (raw_events, normalized_events) so
 * their primary key stays index-local as the table grows, without ever
 * needing a separate created_at-based sort key or a column-type migration.
 *
 * Node's crypto.randomUUID() only produces v4 (fully random) UUIDs, so this
 * is a small hand-rolled implementation per RFC 9562.
 */
export function uuidv7(): string {
  const unixMs = Date.now();
  const rand = randomBytes(10);

  const bytes = Buffer.alloc(16);
  // 48-bit millisecond timestamp, big-endian. Date.now() safely fits in 48
  // bits until roughly the year 10889, so plain Number arithmetic (no
  // BigInt literal, which needs an ES2020+ tsc target) is sufficient.
  bytes.writeUIntBE(unixMs % 0x1000000000000, 0, 6);

  // Version 7 in the top nibble of byte 6.
  bytes[6] = 0x70 | (rand[0] & 0x0f);
  bytes[7] = rand[1];

  // Variant bits (10) in the top two bits of byte 8.
  bytes[8] = 0x80 | (rand[2] & 0x3f);
  bytes[9] = rand[3];
  rand.copy(bytes, 10, 4, 10);

  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
