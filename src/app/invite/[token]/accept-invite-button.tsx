"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { acceptInvitation } from "./actions";

/**
 * Accept, as a real form submit.
 *
 * `acceptInvitation` calls `redirect()` on success, and per CLAUDE.md a
 * redirecting Server Action only reliably navigates when it is invoked via a
 * real `<form action={…}>` — calling it directly from client code for a
 * pending-state pattern leaves the user sitting on this page. Hence a form
 * with a bound action rather than an onClick.
 */
export function AcceptInviteButton({ token }: { token: string }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <form
      action={() => {
        startTransition(async () => {
          const result = await acceptInvitation(token);
          if (result?.error) setError(result.error);
        });
      }}
      className="space-y-2"
    >
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Accepting…" : "Accept invitation"}
      </Button>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </form>
  );
}
