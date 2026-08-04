import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { publicEnv } from "@/lib/env";

const PROTECTED_PREFIXES = ["/w", "/onboarding"];
const AUTH_PATHS = new Set(["/login", "/signup"]);

/**
 * Runs on every request (see `config.matcher` below). Two jobs:
 *
 * 1. Refresh the Supabase session and write the refreshed cookies onto the
 *    response — this MUST happen before any redirect/response is returned,
 *    or a token refresh that completes after the response is committed is
 *    lost, forcing the next request to refresh again.
 * 2. Redirect unauthenticated requests away from `/w/*` (the workspace app).
 *
 * This is NOT the only auth check in the app: Server Actions are POST
 * requests to whatever route rendered them, not separate routes proxy can
 * gate by path — each Server Action re-verifies auth itself. See the
 * `requireUser()` helper used throughout services/ and app/(app)/**.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const env = publicEnv();
  const supabase = createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  const { data, error } = await supabase.auth.getClaims();
  const isAuthenticated = !error && data?.claims != null;

  const { pathname } = request.nextUrl;

  if (PROTECTED_PREFIXES.some((prefix) => pathname.startsWith(prefix)) && !isAuthenticated) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  if (AUTH_PATHS.has(pathname) && isAuthenticated) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: [
    // Everything except static assets and Next's own internals. Route
    // Handlers under /api/** still pass through here (for cookie refresh)
    // but are never redirected — they authenticate themselves (service role,
    // QStash/Slack signature verification, or CRON_SECRET), not via cookies.
    "/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
