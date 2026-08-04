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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/toast";
import { snoozeActionItem } from "./actions";

export function SnoozeButton({
  workspaceId,
  projectId,
  itemId,
}: {
  workspaceId: string;
  projectId: string;
  itemId: string;
}) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState("");
  const [isPending, startTransition] = useTransition();

  function handleSubmit() {
    if (!date) return;
    setOpen(false);
    startTransition(async () => {
      await toast
        .promise(snoozeActionItem(workspaceId, projectId, itemId, date), {
          loading: "Snoozing…",
          success: (result) => result.message,
          error: (err) => (err instanceof Error ? err.message : "Something went wrong"),
        })
        .catch(() => {});
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" disabled={isPending} data-testid={`snooze-${itemId}`} />}>
        {isPending ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}
        Snooze…
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Snooze this item</DialogTitle>
          <DialogDescription>
            It disappears from the default view until this date. Find it again via the Snoozed filter.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor={`snooze-until-${itemId}`}>Snooze until</Label>
          <Input
            id={`snooze-until-${itemId}`}
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button disabled={!date} onClick={handleSubmit}>
            Snooze
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
