"use client";

import { useTransition } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ConfirmActionButton } from "@/components/dashboard/confirm-action-button";
import { toast } from "@/components/ui/toast";

export interface MemberRow {
  userId: string;
  email: string;
  fullName: string | null;
  role: string;
}

export interface AssignableRole {
  key: string;
  label: string;
  description: string | null;
}

interface MembersViewProps {
  title: string;
  description: string;
  members: MemberRow[];
  /** Empty when the viewer may not manage membership — the source of truth is
   * `assignable_roles`, which returns nothing unless the caller holds
   * member.manage and applies the rank ceiling on top. */
  assignableRoles: AssignableRole[];
  currentUserId: string;
  roleLabels: Record<string, string>;
  /**
   * Both must be the Server Action itself or a `.bind(null, …)` of it —
   * NEVER a fresh arrow wrapper. An inline wrapper is not recognised as a
   * serialisable action reference and throws "Functions cannot be passed
   * directly to Client Components" at runtime rather than at build time
   * (see CLAUDE.md). Pages bind their scope id and pass the result.
   */
  changeRoleAction: (userId: string, role: string) => Promise<{ message: string }>;
  removeAction: (userId: string) => Promise<{ message: string }>;
  /**
   * Copy for the remove confirmation, as a TEMPLATE STRING with an `{email}`
   * placeholder — not a function.
   *
   * A function here looks natural and fails at runtime: only Server Actions
   * may cross into a Client Component, and a plain arrow is neither
   * serialisable nor an action reference, so React throws "Functions cannot be
   * passed directly to Client Components" when it tries to stringify the
   * props. The two action props above are fine precisely because they are
   * `.bind(null, …)` of real Server Actions.
   */
  removeDescriptionTemplate: string;
}

/**
 * One roster table, used by both the workspace and client-space screens.
 *
 * Note there is no role check anywhere in here. Whether the viewer may manage
 * membership is answered entirely by `assignableRoles` arriving non-empty —
 * that RPC applies the member.manage check, the `assignable` flag and the rank
 * ceiling server-side, in one place.
 */
export function MembersView({
  title,
  description,
  members,
  assignableRoles,
  currentUserId,
  roleLabels,
  changeRoleAction,
  removeAction,
  removeDescriptionTemplate,
}: MembersViewProps) {
  const [pending, startTransition] = useTransition();
  const canManage = assignableRoles.length > 0;

  function onRoleChange(userId: string, role: string) {
    startTransition(async () => {
      await toast
        .promise(changeRoleAction(userId, role), {
          loading: "Updating role…",
          success: (result) => result.message,
          error: (err) => (err instanceof Error ? err.message : "Could not change this member's role."),
        })
        .catch(() => {});
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              {canManage ? <TableHead className="text-right">Actions</TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((member) => {
              const isSelf = member.userId === currentUserId;
              return (
                <TableRow key={member.userId}>
                  <TableCell className="font-medium">
                    {member.fullName ?? "—"}
                    {isSelf ? <span className="ml-2 text-xs text-muted-foreground">(you)</span> : null}
                  </TableCell>
                  <TableCell>{member.email}</TableCell>
                  <TableCell>
                    {canManage ? (
                      <Select
                        value={member.role}
                        onValueChange={(value) => {
                          if (typeof value === "string" && value !== member.role) {
                            onRoleChange(member.userId, value);
                          }
                        }}
                        disabled={pending}
                      >
                        <SelectTrigger className="w-40" aria-label={`Role for ${member.email}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {assignableRoles.map((role) => (
                            <SelectItem key={role.key} value={role.key}>
                              {role.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Badge variant="secondary">{roleLabels[member.role] ?? member.role}</Badge>
                    )}
                  </TableCell>
                  {canManage ? (
                    <TableCell className="text-right">
                      <ConfirmActionButton
                        action={removeAction.bind(null, member.userId)}
                        triggerLabel="Remove"
                        confirmLabel="Remove"
                        loadingMessage="Removing…"
                        title="Remove this person?"
                        description={removeDescriptionTemplate.replace("{email}", member.email)}
                      />
                    </TableCell>
                  ) : null}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
