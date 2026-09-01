export {
  PERMISSIONS,
  tenantScope,
  workspaceScope,
  spaceScope,
  projectScope,
  type Permission,
  type ScopeLevel,
  type ScopeRef,
} from "./permissions";

export {
  ForbiddenError,
  isForbiddenError,
  getScopePermissions,
  permissionsFor,
  can,
  requirePermission,
} from "./can";
