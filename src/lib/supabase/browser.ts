import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@/lib/db/database.types";
import { publicEnv } from "@/lib/env";

/**
 * Browser-side Supabase client for Client Components (e.g. the Google OAuth
 * sign-in button, realtime subscriptions if we add them later). RLS applies
 * the same as the server client — this is not a privilege escalation, just
 * a client that can run in the browser bundle.
 */
export function createClient() {
  const env = publicEnv();
  return createBrowserClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}
