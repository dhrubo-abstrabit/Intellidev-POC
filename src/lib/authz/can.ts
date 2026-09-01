import "server-only";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import type { Permission, ScopeRef } from "./permissions";

/**
 * Thrown when a Server Action is called by someone without the permission it
 * requires.
 *
 * It exists so the UI can render "Space admins only" instead of surfacing a
 * raw Postgres `42501 new row violates row-level security policy`, which is
 * what a member hitting an admin-only policy sees today.
 */
export class ForbiddenError extends Error {
  readonly permission: Permission;
  readonly scope: ScopeRef;

  constructor(permission: Permission, scope: ScopeRef, message?: string) {
    super(message ?? `You do not have permission to do this (${permission}).`);
    this.name = "ForbiddenError";
    this.permission = permission;
    this.scope = scope;
  }
}

export function isForbiddenError(e: unknown): e is ForbiddenError {
  return e instanceof ForbiddenError || (e instanceof Error && e.name === "ForbiddenError");
}

/**
 * Every permission the current user holds at one scope.
 *
 * Wrapped in React's `cache()`, so a page that gates six controls at the same
 * scope makes ONE round trip, not six. The cache key is the two string
 * arguments and its lifetime is a single request, which is exactly the window
 * over which a permission may be treated as stable.
 *
 * Reads through `my_permissions`, which is itself a loop over the same
 * resolvers RLS uses — so the answer here can never disagree with the answer
 * the database will give when the write is actually attempted. That is worth
 * more than the microseconds a bespoke query would save.
 */
export const getScopePermissions = cache(
  async (level: ScopeRef["level"], id: string): Promise<ReadonlySet<Permission>> => {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("my_permissions", {
      p_scope_level: level,
      p_scope_id: id,
    });

    // Fail CLOSED. A failed permission lookup must never read as "allowed";
    // an empty set disables the UI and makes requirePermission throw, which is
    // the safe direction to be wrong in.
    if (error || !data) return new Set<Permission>();
    return new Set(data as Permission[]);
  },
);

/**
 * Whether the current user may do `permission` at `scope`.
 *
 * For UI only — to disable a control and say why. It is NOT the enforcement
 * boundary: RLS is, and on service-role paths `requirePermission` is. A check
 * that exists only in a component is a courtesy to the user, not a control.
 */
export async function can(permission: Permission, scope: ScopeRef): Promise<boolean> {
  const held = await getScopePermissions(scope.level, scope.id);
  return held.has(permission);
}

/**
 * Throws `ForbiddenError` unless the current user may do `permission` at
 * `scope`.
 *
 * CALL THIS IMMEDIATELY ABOVE EVERY `createServiceClient()` IN A SERVER
 * ACTION. The service-role client bypasses RLS completely, so on those paths
 * no policy runs and this is the only thing standing between a member and an
 * admin-only operation. Keeping the two lines adjacent is deliberate: it lets
 * a reviewer see the gate and the bypass together instead of having to search
 * the function for one.
 *
 * On user-scoped paths it is still worth calling, because failing here
 * produces a sentence a person can act on rather than a Postgres error code.
 */
export async function requirePermission(permission: Permission, scope: ScopeRef): Promise<void> {
  if (!(await can(permission, scope))) {
    throw new ForbiddenError(permission, scope);
  }
}

/** Convenience for gating several controls on one page from a single trip. */
export async function permissionsFor(scope: ScopeRef): Promise<ReadonlySet<Permission>> {
  return getScopePermissions(scope.level, scope.id);
}
