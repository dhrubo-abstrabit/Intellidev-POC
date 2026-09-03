"use client";

import { useActionState, useState, useTransition } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ConfirmActionButton } from "@/components/dashboard/confirm-action-button";
import { toast } from "@/components/ui/toast";
import { createInvitation, resendInvitation, revokeInvitation, type InviteScopeLevel } from "@/lib/invitations/actions";

export interface PendingInvite {
  id: string;
  email: string;
  roleLabel: string;
  invitedBy: string | null;
  expiresAt: string;
  /** Computed on the server. Deriving it here with Date.now() would be an
   * impure call during render — the value would change between renders for
   * reasons unrelated to props, which is exactly what react-hooks/purity
   * guards against. */
  expired: boolean;
}

export interface InviteRole {
  key: string;
  label: string;
}

/** Module-level so the reference is stable — an inline literal here is a new
 * object on every render, which is what caused the render loop described
 * below. */
const INITIAL: { error?: string; result?: { message: string; inviteUrl: string; delivered: boolean } } = {};

interface Props {
  level: InviteScopeLevel;
  scopeId: string;
  invites: PendingInvite[];
  /** Empty when the viewer lacks member.invite — the whole panel hides. */
  roles: InviteRole[];
}

export function InvitationsPanel({ level, scopeId, invites, roles }: Props) {
  const canInvite = roles.length > 0;
  const [pendingOp, startTransition] = useTransition();

  const [state, formAction, submitting] = useActionState(createInvitation.bind(null, level, scopeId), INITIAL);

  // A link minted by "Resend", which happens in an event handler rather than
  // through the form action.
  const [resendLink, setResendLink] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  // DERIVED, not mirrored into state. An earlier version copied the action
  // result into state during render and looped forever: useActionState's
  // initial value was an inline object literal, so it was a new reference on
  // every render, the "has this changed" check was always true, and each
  // render scheduled another. Deriving has no such failure mode — and the one
  // genuinely stateful thing here (which link the user dismissed) is set from
  // an event, where setState belongs.
  const freshLink = resendLink ?? state?.result?.inviteUrl ?? null;
  const showLink = freshLink && freshLink !== dismissed ? freshLink : null;
  const outcome = state?.result?.message ?? null;

  if (!canInvite && invites.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Invitations</CardTitle>
        <CardDescription>
          {canInvite
            ? "Invitations expire after 7 days and can only be used once."
            : "Pending invitations. Only people who can invite may send or revoke these."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {canInvite ? (
          <form action={formAction} className="flex flex-wrap items-end gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="invite-email">Email</Label>
              <Input
                id="invite-email"
                name="email"
                type="email"
                required
                placeholder="person@company.com"
                className="w-64"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="invite-role">Role</Label>
              <Select name="role" defaultValue={roles[roles.length - 1]?.key}>
                <SelectTrigger id="invite-role" className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {roles.map((r) => (
                    <SelectItem key={r.key} value={r.key}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Sending…" : "Send invitation"}
            </Button>
            {state?.error ? <p className="w-full text-sm text-destructive">{state.error}</p> : null}
          </form>
        ) : null}

        {outcome ? <p className="text-sm text-muted-foreground">{outcome}</p> : null}
        {showLink ? <FreshLink url={showLink} onDismiss={() => setDismissed(showLink)} /> : null}

        {invites.length === 0 ? (
          <p className="text-sm text-muted-foreground">No pending invitations.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>Invited by</TableHead>
                {canInvite ? <TableHead className="text-right">Actions</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {invites.map((invite) => {
                return (
                  <TableRow key={invite.id}>
                    <TableCell className="font-medium">{invite.email}</TableCell>
                    <TableCell>{invite.roleLabel}</TableCell>
                    <TableCell>
                      {invite.expired ? (
                        <Badge variant="destructive">Expired</Badge>
                      ) : (
                        <span className="text-muted-foreground">
                          {new Date(invite.expiresAt).toLocaleDateString("en-GB", {
                            day: "numeric",
                            month: "short",
                          })}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{invite.invitedBy ?? "—"}</TableCell>
                    {canInvite ? (
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={pendingOp}
                            onClick={() =>
                              startTransition(async () => {
                                await toast
                                  .promise(resendInvitation(level, scopeId, invite.id), {
                                    loading: "Resending…",
                                    success: (r) => {
                                      setResendLink(r.inviteUrl);
                                      return r.message;
                                    },
                                    error: (err) =>
                                      err instanceof Error ? err.message : "Could not resend.",
                                  })
                                  .catch(() => {});
                              })
                            }
                          >
                            Resend
                          </Button>
                          <ConfirmActionButton
                            action={revokeInvitation.bind(null, level, scopeId, invite.id)}
                            triggerLabel="Revoke"
                            confirmLabel="Revoke"
                            loadingMessage="Revoking…"
                            title="Revoke this invitation?"
                            description={`The link sent to ${invite.email} stops working immediately.`}
                          />
                        </div>
                      </TableCell>
                    ) : null}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Shows a freshly minted invite link with a copy button.
 *
 * This is the affordance that makes invitations usable before SES has left the
 * sandbox: the link works regardless of whether the email went anywhere, and
 * pasting it into Slack is a legitimate way to invite someone.
 */
function FreshLink({ url, onDismiss }: { url: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-md border border-dashed bg-muted/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">Invitation link — copy it now, it cannot be shown again</p>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              navigator.clipboard.writeText(url).then(
                () => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                },
                () => setCopied(false),
              );
            }}
          >
            {copied ? "Copied" : "Copy link"}
          </Button>
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      </div>
      <p className="mt-2 font-mono text-xs break-all text-muted-foreground">{url}</p>
    </div>
  );
}
