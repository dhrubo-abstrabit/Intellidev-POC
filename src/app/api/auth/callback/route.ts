import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * Shared landing spot for both the Google OAuth redirect and the
 * email-confirmation link (when Supabase Auth is configured to require
 * confirmation — off by default locally, likely on in production). Both
 * flows redirect here with a `?code=...` to exchange for a session.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/";

  // Behind a reverse proxy (AWS Amplify's SSR compute in front of `next
  // start`), the Node process sees `Host: localhost:<port>` — the internal
  // bind address — not the public domain, so `origin` above resolves to
  // `http://localhost:3000` even in production. The real public host only
  // survives in `x-forwarded-host`/`x-forwarded-proto`, set by the proxy.
  // Vercel's proxy preserves Host correctly, so this only kicks in when
  // those headers are actually present.
  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto") ?? "https";
  const redirectOrigin = forwardedHost
    ? `${forwardedProto}://${forwardedHost}`
    : origin;

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${redirectOrigin}${next}`);
    }
    // Swallowing this used to leave "auth_callback_failed" as the only
    // signal — logging the real cause (commonly a PKCE code-verifier
    // cookie missing because the OAuth flow started on a different origin,
    // e.g. localhost vs 127.0.0.1) makes this diagnosable without guessing.
    // TEMPORARY: cookie names (never values) are logged too, to check
    // whether the `...-code-verifier` cookie set at sign-in start actually
    // survived the round trip through Google/Supabase back to this host —
    // remove once the Amplify PKCE failure is root-caused.
    console.error("Auth callback code exchange failed:", {
      message: error.message,
      name: error.name,
      status: error.status,
      cookieNames: request.cookies.getAll().map((c) => c.name),
    });
  }

  return NextResponse.redirect(`${redirectOrigin}/login?error=auth_callback_failed`);
}
