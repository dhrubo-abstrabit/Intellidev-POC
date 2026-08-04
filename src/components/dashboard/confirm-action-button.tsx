"use client";

import { useState, useTransition } from "react";
import { Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";

interface ConfirmActionButtonProps {
  action: () => Promise<{ message: string }>;
  triggerLabel: string;
  confirmLabel: string;
  loadingMessage: string;
  title: string;
  description: string;
  triggerVariant?: "outline" | "ghost";
  size?: "xs" | "sm" | "default";
  "data-testid"?: string;
}

/**
 * Same fire-and-toast pattern as AsyncButton, gated behind a confirmation
 * dialog — for actions that are disruptive enough (disconnect, dismiss)
 * that a stray click shouldn't run them immediately.
 */
export function ConfirmActionButton({
  action,
  triggerLabel,
  confirmLabel,
  loadingMessage,
  title,
  description,
  triggerVariant = "outline",
  size = "sm",
  ...rest
}: ConfirmActionButtonProps) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  function handleConfirm() {
    setOpen(false);
    startTransition(async () => {
      await toast
        .promise(action(), {
          loading: loadingMessage,
          success: (result) => result.message,
          error: (err) => (err instanceof Error ? err.message : "Something went wrong"),
        })
        .catch(() => {});
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant={triggerVariant} size={size} disabled={isPending} {...rest} />}>
        {isPending ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}
        {triggerLabel}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button variant="destructive" onClick={handleConfirm}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
