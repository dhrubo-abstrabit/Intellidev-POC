import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import type { Database } from "@/lib/db/database.types";
import { publicEnv } from "@/lib/env";

/**
 * User-scoped Supabase client for Server Components, Server Actions, and
 * Route Handlers. RLS applies — every query is automatically filtered to
 * whatever the current session's `auth.uid()` can see.
 *
 * Must be constructed fresh per request (never module-level singleton) —
 * it captures this request's cookie jar.
 *
 * `@supabase/ssr`'s server client uses lazy session initialization: it does
 * NOT read the session (and therefore does not attach an Authorization
 * header to PostgREST requests) until `getClaims()`/`getUser()`/
 * `getSession()` is called on THAT SPECIFIC client instance. A client that
 * only ever calls `.from(...)` without one of those first is sent as
 * anonymous — every RLS policy referencing `auth.uid()` then evaluates
 * against NULL, so INSERTs violate `with check` and SELECTs silently return
 * zero rows (no error, just empty results, which is its own trap). We hit
 * this for real: `createWorkspace` called `requireUser()` (hydrating ITS
 * OWN internal client) and then created a SEPARATE `createClient()` for the
 * insert — that second instance was never hydrated, so `owner_id =
 * auth.uid()` failed with "new row violates row-level security policy".
 *
 * Fixing every call site to remember "call getClaims() before your first
 * query, even if you don't need the result" doesn't scale. Instead, force
 * the hydration here, once, so every client this function returns is
 * already authenticated before the caller can touch it.
 */
export async function createClient() {
  const cookieStore = await cookies();
  const env = publicEnv();

  const client = createServerClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        // Server Components cannot set cookies — only Server Actions, Route
        // Handlers, and proxy.ts can. Session refresh in those contexts is
        // handled by proxy.ts; a Server Component calling this is expected
        // to occasionally hit the "read-only" case, which is safe to ignore
        // as long as proxy.ts is refreshing the session on every request.
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // no-op — see comment above.
        }
      },
    },
  });

  // Discard the result deliberately — this is purely to trigger lazy
  // hydration. Callers that need the user still call getUser()/requireUser()
  // themselves; an unauthenticated request just gets a client whose queries
  // correctly run as anon (RLS then legitimately returns nothing).
  await client.auth.getClaims();
  return client;
}
