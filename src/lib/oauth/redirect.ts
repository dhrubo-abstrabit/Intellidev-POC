import { publicEnv } from "@/lib/env";
import type { OAuthProvider } from "./providers";

/**
 * The redirect_uri every connector's authorize URL and token exchange must
 * use — Google/Slack both require an EXACT match against what's registered
 * in their respective app consoles. For Slack this is byte-identical to the
 * URI already registered at console.slack.com/apps (the callback route
 * moved from a static `api/oauth/slack/callback` folder to the dynamic
 * `api/oauth/[provider]/callback`, but both resolve the same public URL), so
 * migrating Slack onto this shared helper needs no dashboard change.
 */
export function oauthRedirectUri(provider: OAuthProvider): string {
  return `${publicEnv().NEXT_PUBLIC_APP_URL}/api/oauth/${provider}/callback`;
}

/** Where the callback route sends the browser after finishing (or failing)
 * a connect attempt — the Integrations page reads `connect`/`status` to
 * render the outcome. Superseds the old Slack-only `?slack=<status>` shape. */
export function integrationsRedirectUrl(
  origin: string,
  workspaceId: string,
  projectId: string,
  provider: string,
  status: string,
): string {
  const url = new URL(`${origin}/w/${workspaceId}/p/${projectId}/integrations`);
  url.searchParams.set("connect", provider);
  url.searchParams.set("status", status);
  return url.toString();
}
