import "server-only";
import { googleEnv } from "@/lib/env";
import { oauthRedirectUri } from "@/lib/oauth/redirect";
import type { OAuthProvider } from "@/lib/oauth/providers";
import { ConnectorRefreshError } from "@/connectors/errors";
import { IDENTITY_SCOPES } from "./scopes";
import type { ConnectorCredentials } from "@/connectors/types";

const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  expires_in?: number;
  id_token?: string;
  error?: string;
  error_description?: string;
}

/** Decodes an id_token's payload WITHOUT verifying its signature. Correct
 * here specifically because this token came directly from Google's token
 * endpoint over TLS in a request we just made ourselves — it never passed
 * through the browser or a redirect, so there is nothing for a forged
 * signature to defend against. (Contrast with verifying an id_token handed
 * to you by a client, which absolutely would need signature verification.) */
function decodeIdTokenUnverified(idToken: string): { sub?: string; email?: string } {
  const payload = idToken.split(".")[1];
  if (!payload) return {};
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

function expiresAtFrom(expiresIn: number | undefined): Date | undefined {
  return typeof expiresIn === "number" ? new Date(Date.now() + expiresIn * 1000) : undefined;
}

/**
 * Builds the Google consent screen URL. `scopes` should be the provider's
 * OWN scope list only (DRIVE_SCOPES, GMAIL_SCOPES, or CHAT_SCOPES) —
 * IDENTITY_SCOPES is always added here, so callers must not add it again.
 *
 * Load-bearing params:
 * - access_type=offline: without it Google returns NO refresh_token and the
 *   integration silently dies ~60 minutes after connect.
 * - prompt=consent: Google only issues a refresh_token on the FIRST grant
 *   per (user, client, scope-set) — reconnecting without this re-uses the
 *   existing grant and returns a bundle with no refresh_token at all.
 * - include_granted_scopes is deliberately OMITTED: it would carry forward
 *   every previously-granted scope onto the new token, so e.g. a Gmail
 *   connect could end up with a token that also reads Drive if the same
 *   Google account had connected Drive earlier. Three least-privilege
 *   grants is worth three separate consent screens.
 * - scopes are space-joined (Google's convention) — NOT comma-joined like
 *   Slack's.
 */
export function googleAuthorizeUrl(options: {
  provider: OAuthProvider;
  scopes: string[];
  state: string;
  loginHint?: string;
}): string {
  const env = googleEnv();
  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.searchParams.set("client_id", env.GOOGLE_CONNECTOR_CLIENT_ID);
  url.searchParams.set("redirect_uri", oauthRedirectUri(options.provider));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", [...IDENTITY_SCOPES, ...options.scopes].join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", options.state);
  if (options.loginHint) url.searchParams.set("login_hint", options.loginHint);
  return url.toString();
}

/**
 * Exchanges an authorization code for a token bundle. Throws
 * "MISSING_REFRESH_TOKEN: ..." rather than storing a credential that will
 * die in ~60 minutes, and "MISSING_SCOPES: ..." if Google granted fewer
 * scopes than requested — both are pattern-matched by
 * api/oauth/[provider]/callback/route.ts into distinct, actionable status
 * codes for the Integrations page banner.
 */
export async function exchangeGoogleCode(
  provider: OAuthProvider,
  code: string,
  requiredScopes: string[],
): Promise<ConnectorCredentials> {
  const env = googleEnv();
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CONNECTOR_CLIENT_ID,
      client_secret: env.GOOGLE_CONNECTOR_CLIENT_SECRET,
      code,
      redirect_uri: oauthRedirectUri(provider),
      grant_type: "authorization_code",
    }),
  });
  const data = (await res.json()) as GoogleTokenResponse;

  if (!res.ok || data.error) {
    throw new Error(`Google OAuth exchange failed: ${data.error ?? res.statusText}`);
  }
  if (!data.access_token) {
    throw new Error("Google OAuth exchange failed: no access_token in response");
  }
  if (!data.refresh_token) {
    throw new Error(
      "MISSING_REFRESH_TOKEN: Google did not return a refresh_token — the account may have an existing grant for this app that needs to be removed at myaccount.google.com/permissions before reconnecting",
    );
  }

  const grantedScopes = new Set((data.scope ?? "").split(" ").filter(Boolean));
  const missingScopes = requiredScopes.filter((s) => !grantedScopes.has(s));
  if (missingScopes.length > 0) {
    throw new Error(`MISSING_SCOPES: Google did not grant: ${missingScopes.join(", ")}`);
  }

  const { sub, email } = data.id_token ? decodeIdTokenUnverified(data.id_token) : {};
  if (!sub) {
    throw new Error("Google OAuth exchange failed: id_token had no sub claim");
  }

  return {
    tokens: {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      scope: data.scope,
      token_type: data.token_type,
      id_token: data.id_token,
    },
    externalAccountId: sub,
    externalAccountLabel: email,
    accessTokenExpiresAt: expiresAtFrom(data.expires_in),
  };
}

/**
 * Refreshes an access token. MUST be called with, and returns, the COMPLETE
 * token bundle — Google's refresh response omits refresh_token entirely, so
 * this merges the original one forward rather than dropping it. Losing it
 * would silently convert a working credential into one that can never
 * refresh again the next time it's needed.
 */
export async function refreshGoogleTokens(credentials: ConnectorCredentials): Promise<ConnectorCredentials> {
  const refreshToken = credentials.tokens.refresh_token as string | undefined;
  if (!refreshToken) {
    throw new ConnectorRefreshError("No refresh_token stored for this credential", { permanent: true });
  }

  const env = googleEnv();
  let res: Response;
  try {
    res = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.GOOGLE_CONNECTOR_CLIENT_ID,
        client_secret: env.GOOGLE_CONNECTOR_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });
  } catch (err) {
    // Network failure — can't tell if the grant is dead, so treat as transient.
    throw new ConnectorRefreshError(`Network error refreshing Google token: ${String(err)}`, { permanent: false });
  }

  const data = (await res.json()) as GoogleTokenResponse;
  if (!res.ok || data.error) {
    // invalid_grant is Google's explicit "this refresh token will never
    // work again" signal (revoked by the user, or the grant expired from
    // inactivity) — everything else (5xx, transient rate limiting) is
    // treated as "try again next run", not permanent.
    const permanent = data.error === "invalid_grant";
    throw new ConnectorRefreshError(`Google token refresh failed: ${data.error ?? res.statusText}`, { permanent });
  }
  if (!data.access_token) {
    throw new ConnectorRefreshError("Google token refresh failed: no access_token in response", { permanent: false });
  }

  return {
    ...credentials,
    tokens: {
      ...credentials.tokens,
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? refreshToken,
      scope: data.scope ?? credentials.tokens.scope,
      token_type: data.token_type ?? credentials.tokens.token_type,
    },
    accessTokenExpiresAt: expiresAtFrom(data.expires_in),
  };
}

/**
 * Best-effort revoke. Prefers the refresh token over the access token: it
 * kills the whole grant (all derived access tokens too), and unlike the
 * access token it's still valid when disconnect runs long after the last
 * sync (access tokens are typically expired by then).
 */
export async function revokeGoogleToken(credentials: ConnectorCredentials): Promise<void> {
  const token = (credentials.tokens.refresh_token ?? credentials.tokens.access_token) as string | undefined;
  if (!token) return;
  await fetch(`${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: "POST" }).catch(() => {});
}
