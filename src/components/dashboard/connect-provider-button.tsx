"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Nango from "@nangohq/frontend";
import { Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";

// Read directly via literal `process.env.NEXT_PUBLIC_*` expressions, NOT
// through lib/env.ts's publicEnv() — Next.js's client-bundle inlining only
// replaces a literal `process.env.NEXT_PUBLIC_X` text pattern found in a
// file that's actually part of the client bundle. publicEnv() passes the
// whole `process.env` object into Zod at once, which works fine server-side
// (real env, no inlining needed) but produces `undefined` for every field in
// the browser, since nothing in that call statically names any single key.
// Caught by actually clicking Connect in a real browser — see
// NANGO_MIGRATION_LOG.md.
const NANGO_HOST = process.env.NEXT_PUBLIC_NANGO_HOST;
const NANGO_CONNECT_URL = process.env.NEXT_PUBLIC_NANGO_CONNECT_URL;

interface ConnectProviderButtonProps {
  provider: string;
  /** Disables the button and says why on hover. UI courtesy only — the
   * connect action re-checks connection.manage server-side. */
  disabledReason?: string;
  workspaceId: string;
  projectId: string;
  /** Passed down as a plain Server Action reference (not wrapped in a new
   * arrow function) — see CLAUDE.md's Server-Action-as-prop gotcha. */
  createConnectSession: (workspaceId: string, projectId: string, provider: string) => Promise<{ sessionToken: string }>;
  finalizeConnection: (
    workspaceId: string,
    projectId: string,
    provider: string,
    connectionId: string,
    providerConfigKey: string,
  ) => Promise<{ message: string }>;
  /** Fired (not awaited by the UI) when the Connect UI closes without a
   * `connect` event ever reaching us — see the `close` handler below. */
  reconcileConnections: (workspaceId: string, projectId: string) => Promise<{ message: string; reconciledCount: number }>;
}

/**
 * Drives Nango's Connect UI (a popup, not a redirect) — replaces the old
 * form-submit-to-authorize-URL pattern entirely now that Nango owns the
 * OAuth handshake (see NANGO_MIGRATION_LOG.md). Keeps the same
 * `data-testid` shape (`connect-${provider}`) so existing Playwright
 * selectors still resolve unchanged.
 */
export function ConnectProviderButton({
  provider,
  disabledReason,
  workspaceId,
  projectId,
  createConnectSession,
  finalizeConnection,
  reconcileConnections,
}: ConnectProviderButtonProps) {
  const [isPending, setIsPending] = useState(false);
  const router = useRouter();

  const handleClick = () => {
    if (!NANGO_HOST || !NANGO_CONNECT_URL) {
      toast.add({ title: "Nango is not configured for this environment.", type: "error" });
      return;
    }
    setIsPending(true);
    // Self-hosted Nango must override both URLs — the SDK's built-in
    // defaults point at Nango Cloud.
    const nango = new Nango({ host: NANGO_HOST });
    // Local to this one popup's lifecycle, not component state — a fresh
    // handleClick call gets a fresh closure, so there's no cross-click state
    // to reset.
    let connected = false;
    const connect = nango.openConnectUI({
      baseURL: NANGO_CONNECT_URL,
      apiURL: NANGO_HOST,
      onEvent: (event) => {
        if (event.type === "connect") {
          connected = true;
          const { connectionId, providerConfigKey } = event.payload;
          toast
            .promise(finalizeConnection(workspaceId, projectId, provider, connectionId, providerConfigKey), {
              loading: "Finishing connection…",
              success: (result) => result.message,
              error: (err) => (err instanceof Error ? err.message : "Could not finish connecting"),
            })
            // toast.promise mirrors the input promise's rejection — the
            // error toast already surfaced it, so swallow here rather than
            // let it become an unhandled rejection.
            .catch(() => {})
            .finally(() => {
              setIsPending(false);
              router.refresh();
            });
        } else if (event.type === "error") {
          toast.add({ title: event.payload.errorMessage, type: "error" });
          setIsPending(false);
        } else if (event.type === "close") {
          setIsPending(false);
          // No `connect` event ever reached us. Either the user backed out
          // (the common case — reconcileConnections below finds nothing and
          // stays silent) or the grant actually succeeded on Nango's side
          // but the tab/network dropped before the event arrived — free
          // self-hosted Nango has no webhooks, so this is the only place
          // (besides a manual "Check for connections" click) that can catch
          // that. Fire-and-forget and best-effort: a failure here is not
          // something the user did, so it must not surface as an error.
          if (!connected) {
            reconcileConnections(workspaceId, projectId)
              .then((result) => {
                if (result.reconciledCount > 0) {
                  toast.add({ title: result.message, type: "success" });
                  router.refresh();
                }
              })
              .catch(() => {});
          }
        }
      },
    });

    createConnectSession(workspaceId, projectId, provider)
      .then((res) => connect.setSessionToken(res.sessionToken))
      .catch((err) => {
        toast.add({ title: err instanceof Error ? err.message : "Could not start the connection", type: "error" });
        setIsPending(false);
      });
  };

  return (
    <Button
      size="sm"
      disabled={isPending || Boolean(disabledReason)}
      title={disabledReason}
      onClick={handleClick}
      data-testid={`connect-${provider}`}
    >
      {isPending ? (
        <>
          <Loader2Icon className="animate-spin" aria-hidden="true" />
          Connecting…
        </>
      ) : (
        "Connect"
      )}
    </Button>
  );
}
