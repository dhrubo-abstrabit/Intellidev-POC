/**
 * The permission vocabulary, mirrored from `public.permissions`.
 *
 * The DATABASE is authoritative — 20260901002200_rbac_seed.sql seeds the real
 * catalog and the FK from role_permissions.permission enforces it. This file
 * exists so TypeScript can reject a typo at compile time instead of letting it
 * become a permission that matches nothing and silently denies everyone, which
 * is the failure mode that looks exactly like working security.
 *
 * `permissions.test.ts` parses the seed migration and asserts this list is
 * identical to it, so the two cannot drift without a red test.
 *
 * Adding a permission means: add it to the seed migration, add it here, grant
 * it to whichever roles need it. Adding a ROLE, by contrast, touches neither
 * this file nor any other TypeScript — that asymmetry is the point of the
 * whole design.
 */
export const PERMISSIONS = [
  // Tenant
  "tenant.read",
  "tenant.update",
  // Billing
  "billing.read",
  "billing.manage",
  "usage.read",
  // Audit
  "audit.read",
  // Membership
  "member.read",
  "member.invite",
  "member.manage",
  // Structure
  "workspace.create",
  "workspace.read",
  "workspace.manage",
  "workspace.delete",
  "space.create",
  "space.read",
  "space.manage",
  "space.delete",
  "project.create",
  "project.read",
  "project.manage",
  "project.delete",
  // Contacts
  "contact.read",
  "contact.manage",
  // Connections
  "connection.read",
  "connection.manage",
  // Data
  "data.read",
  "sync.trigger",
  // Tasks
  "task.read",
  "task.update",
  "task.assign",
  // Documents
  "document.read",
  "document.write",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * The four levels of the hierarchy that carry permissions. `platform` is a
 * real value of the DB's `scope_level` enum but is deliberately absent here:
 * nothing in the app may address the platform scope, and leaving it out of the
 * type means a Server Action cannot accidentally ask about it.
 */
export type ScopeLevel = "tenant" | "workspace" | "space" | "project";

export interface ScopeRef {
  level: ScopeLevel;
  id: string;
}

/** Convenience constructors, so call sites read as prose. */
export const tenantScope = (id: string): ScopeRef => ({ level: "tenant", id });
export const workspaceScope = (id: string): ScopeRef => ({ level: "workspace", id });
export const spaceScope = (id: string): ScopeRef => ({ level: "space", id });
export const projectScope = (id: string): ScopeRef => ({ level: "project", id });
