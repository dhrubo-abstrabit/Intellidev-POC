"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  createTeamMember,
  updateTeamMember,
  type TeamMemberActionResult,
} from "@/app/(app)/w/[workspaceId]/team-members/actions";
import type { TeamMember } from "@/app/(app)/w/[workspaceId]/team-members/types";

interface TeamMemberDialogProps {
  workspaceId: string;
  /** Omit for create mode; pass the row being edited for edit mode. */
  member?: TeamMember;
  triggerLabel: string;
  triggerVariant?: "default" | "outline" | "ghost";
  triggerSize?: "sm" | "default";
}

/**
 * One reusable Dialog-based form for both create and edit — which Server
 * Action it binds to depends on whether `member` was passed in. Watches
 * `isPending` fall back to false with no `state.error` (a transition that
 * was submitting and just settled successfully) to close itself, rather
 * than requiring the caller to manage open state around the mutation.
 */
export function TeamMemberDialog({
  workspaceId,
  member,
  triggerLabel,
  triggerVariant = "default",
  triggerSize = "sm",
}: TeamMemberDialogProps) {
  const [open, setOpen] = useState(false);
  const boundAction = member
    ? updateTeamMember.bind(null, workspaceId, member.id)
    : createTeamMember.bind(null, workspaceId);
  const [state, formAction, isPending] = useActionState<TeamMemberActionResult, FormData>(boundAction, {});
  const wasPending = useRef(false);

  useEffect(() => {
    if (wasPending.current && !isPending && !state.error) {
      setOpen(false);
    }
    wasPending.current = isPending;
  }, [isPending, state]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant={triggerVariant} size={triggerSize} />}>{triggerLabel}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{member ? "Edit team member" : "Add team member"}</DialogTitle>
          <DialogDescription>
            {member ? "Update this roster entry." : "Add a person to this workspace's team roster."}
          </DialogDescription>
        </DialogHeader>
        {/* Keyed on the row's own updated_at (not just its id) so a
         * revalidate after a successful save — which hands this already-
         * mounted dialog a member prop with new field values — remounts the
         * form and reseeds its uncontrolled inputs, instead of leaving them
         * holding stale defaultValues Base UI would otherwise warn about. */}
        <form key={member ? `${member.id}-${member.updated_at}` : "new"} action={formAction} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor={`team-member-name-${member?.id ?? "new"}`}>Name</Label>
            <Input
              id={`team-member-name-${member?.id ?? "new"}`}
              name="name"
              defaultValue={member?.name ?? ""}
              required
              maxLength={160}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`team-member-email-${member?.id ?? "new"}`}>Email</Label>
            <Input
              id={`team-member-email-${member?.id ?? "new"}`}
              name="email"
              type="email"
              defaultValue={member?.email ?? ""}
              required
              maxLength={320}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`team-member-role-${member?.id ?? "new"}`}>Role</Label>
            <Input
              id={`team-member-role-${member?.id ?? "new"}`}
              name="role"
              defaultValue={member?.role ?? ""}
              maxLength={160}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`team-member-description-${member?.id ?? "new"}`}>Description (optional)</Label>
            <Textarea
              id={`team-member-description-${member?.id ?? "new"}`}
              name="description"
              defaultValue={member?.description ?? ""}
              maxLength={2000}
            />
          </div>
          {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
          <DialogFooter>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Saving..." : member ? "Save changes" : "Add team member"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
