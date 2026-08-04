import "server-only";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export interface AuthedUser {
  id: string;
  email: string | undefined;
}

/**
 * Returns the current user, or null if there isn't one. Use in places that
 * render differently for signed-in vs. signed-out (e.g. the root page).
 */
export async function getUser(): Promise<AuthedUser | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims) return null;
  return { id: data.claims.sub, email: data.claims.email as string | undefined };
}

/**
 * Returns the current user or redirects to /login. Call this at the top of
 * every Server Action and every Server Component under a protected route —
 * proxy.ts refreshes sessions and redirects page navigations, but it does
 * NOT protect Server Actions (they're POSTs to whatever route rendered
 * them, not separate routes proxy can gate by path). This is the real
 * enforcement point.
 */
export async function requireUser(): Promise<AuthedUser> {
  const user = await getUser();
  if (!user) {
    redirect("/login");
  }
  return user;
}
