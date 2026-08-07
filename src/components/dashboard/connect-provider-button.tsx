"use client";

import { useFormStatus } from "react-dom";
import { Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * connectProvider() calls redirect() internally — that only reliably
 * triggers a real navigation when invoked through a native form submit, not
 * a direct client-side call, so this stays a <form>/useFormStatus pair
 * rather than the AsyncButton/toast pattern used elsewhere on this page.
 * Generic replacement for the old per-provider ConnectSlackButton — keeps
 * the same `data-testid` shape (`connect-${provider}`) so existing
 * Playwright selectors (`connect-slack`) still resolve unchanged.
 */
export function ConnectProviderButton({ provider }: { provider: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" disabled={pending} data-testid={`connect-${provider}`}>
      {pending ? (
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
