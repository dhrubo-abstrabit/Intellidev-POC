"use client";

import { useTransition } from "react";
import type { ComponentProps, ReactNode } from "react";
import { Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";

interface AsyncButtonProps extends Omit<ComponentProps<typeof Button>, "onClick" | "disabled"> {
  /** Must resolve with a message to show in the success toast, or throw with
   * a message to show in the error toast — see integrations/actions.ts and
   * items/actions.ts for the shape every action here already returns. */
  action: () => Promise<{ message: string }>;
  loadingMessage: string;
  pendingLabel?: ReactNode;
}

/**
 * Fires a Server Action directly (not via a form submit) so its result can
 * drive a toast — loading while in flight, success/error once it settles.
 * Only safe for actions that don't call redirect(): a form is still the
 * right tool for those (see ConnectSlackButton).
 */
export function AsyncButton({ action, children, loadingMessage, pendingLabel, ...props }: AsyncButtonProps) {
  const [isPending, startTransition] = useTransition();

  return (
    <Button
      {...props}
      disabled={isPending}
      onClick={() => {
        startTransition(async () => {
          await toast
            .promise(action(), {
              loading: loadingMessage,
              success: (result) => result.message,
              error: (err) => (err instanceof Error ? err.message : "Something went wrong"),
            })
            // toast.promise mirrors the input promise's rejection — the
            // error toast already surfaced it, so swallow here rather than
            // let it become an unhandled rejection.
            .catch(() => {});
        });
      }}
    >
      {isPending ? (
        <>
          <Loader2Icon className="animate-spin" aria-hidden="true" />
          {pendingLabel ?? children}
        </>
      ) : (
        children
      )}
    </Button>
  );
}
