import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db/database.types";
import { publicEnv, supabaseServerEnv } from "@/lib/env";

/**
 * Service-role Supabase client — BYPASSES ROW LEVEL SECURITY ENTIRELY.
 *
 * This is the trust boundary for the whole app: everything that reads
 * connector_credentials, raw_events, llm_runs, or integration_cursors goes
 * through this client, and nothing else should. The `server-only` import
 * above makes it a build-time error (not just a convention) to pull this
 * into a Client Component bundle.
 *
 * Never construct this ad hoc with `createClient(url, serviceRoleKey)`
 * elsewhere in the codebase — always import it from here, so "does this
 * code path bypass RLS?" is answerable by checking the import list.
 */
export function createServiceClient() {
  const env = publicEnv();
  const { SUPABASE_SERVICE_ROLE_KEY } = supabaseServerEnv();

  return createSupabaseClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
