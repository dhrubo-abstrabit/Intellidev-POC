/**
 * PostgREST/Postgres exchange `bytea` columns as a `\x`-prefixed hex string
 * over the JSON API, never as a raw byte array — handing a Buffer straight
 * to supabase-js would get JSON.stringify'd into `{"type":"Buffer","data":
 * [...]}`, which Postgres cannot cast to bytea at all. Use these at every
 * boundary where a Buffer crosses into or out of a bytea column.
 *
 * Lives here (previously: not lib/crypto/tokens.ts, now deleted entirely by
 * the Nango migration) because it has a non-token consumer: services/sync/
 * run-sync.ts hashes raw event payloads into raw_events' payload_hash bytea
 * column, which has nothing to do with credential encryption. Keeping it
 * separate meant that deletion didn't have to touch this call site.
 */
export function toBytea(buffer: Buffer): string {
  return `\\x${buffer.toString("hex")}`;
}

export function fromBytea(value: string): Buffer {
  return Buffer.from(value.replace(/^\\x/, ""), "hex");
}
