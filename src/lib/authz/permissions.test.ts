import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PERMISSIONS } from "./permissions";

/**
 * Drift guard between the TypeScript permission union and the seed migration
 * that populates `public.permissions`.
 *
 * Without this, adding a permission to the database and forgetting the TS side
 * fails at the call site with a type error (annoying but loud), while removing
 * one from the database and leaving it here fails at RUNTIME by asking for a
 * permission nobody holds — a silent, total denial that looks like working
 * security. This test is aimed squarely at the second case.
 *
 * It parses SQL rather than querying a database on purpose: it belongs in the
 * fast unit suite that runs on every commit, not in the integration suite that
 * needs a live Postgres.
 */
const SEED = join(
  process.cwd(),
  "supabase",
  "migrations",
  "20260901002200_rbac_seed.sql",
);

/**
 * Pulls every `'resource.action'` literal out of the `insert into
 * public.permissions` statement. That block contains both permission keys and
 * `requires` back-references; every `requires` value is itself a key (the
 * self-FK guarantees it), so collecting the union and de-duplicating gives
 * exactly the key set. Descriptions cannot false-positive — the pattern
 * demands the whole quoted string be a dotted lowercase token.
 */
function permissionKeysFromSeed(): Set<string> {
  const sql = readFileSync(SEED, "utf8");
  const start = sql.indexOf("insert into public.permissions");
  expect(start, "seed migration must contain the permissions insert").toBeGreaterThan(-1);

  const end = sql.indexOf(";", start);
  expect(end, "permissions insert must be terminated").toBeGreaterThan(start);

  const block = sql.slice(start, end);
  const keys = block.matchAll(/'([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)'/g);
  return new Set([...keys].map((m) => m[1]));
}

describe("permission catalog", () => {
  it("matches the seed migration exactly", () => {
    const fromSeed = [...permissionKeysFromSeed()].sort();
    const fromCode = [...PERMISSIONS].sort();
    expect(fromCode).toEqual(fromSeed);
  });

  it("has no duplicates", () => {
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
  });

  it("uses the resource.action shape the DB CHECK constraint enforces", () => {
    for (const p of PERMISSIONS) {
      expect(p, `${p} must match the permissions_key_check pattern`).toMatch(
        /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/,
      );
    }
  });
});
