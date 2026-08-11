import { z } from "zod";

// Mirrors the DB CHECK constraints in
// supabase/migrations/20260810090000_team_members.sql.
export const teamMemberSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(160),
  email: z.string().trim().toLowerCase().email("Enter a valid email").max(320),
  role: z.string().trim().max(160).optional(),
  description: z.string().trim().max(2000).optional(),
});
export type TeamMemberInput = z.infer<typeof teamMemberSchema>;
