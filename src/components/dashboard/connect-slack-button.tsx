"use client";

import { useFormStatus } from "react-dom";
import { Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * connectSlack() calls redirect() internally — that only reliably triggers
 * a real navigation when invoked through a native form submit, not a direct
 * client-side call, so this stays a <form>/useFormStatus pair rather than
 * the AsyncButton/toast pattern used everywhere else on this page.
 */
export function ConnectSlackButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" disabled={pending} data-testid="connect-slack">
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
