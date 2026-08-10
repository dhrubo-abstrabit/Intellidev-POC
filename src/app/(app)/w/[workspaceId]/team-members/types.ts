import type { Database } from "@/lib/db/database.types";

// Workspace-level roster entry — see supabase/migrations/20260810090000_team_members.sql.
// Not to be confused with components/items/types.ts's WorkspaceMember, which
// is an unrelated concept (a real logged-in workspace_members account used
// by the task-assignee picker).
export type TeamMember = Database["public"]["Tables"]["team_members"]["Row"];
