"use client";

import { useTransition } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ConfirmActionButton } from "@/components/dashboard/confirm-action-button";
import { toast } from "@/components/ui/toast";
import { changeWorkspaceMemberRole, removeWorkspaceMember } from "./actions";

export interface MemberRow {
  userId: string;
  email: string;
  fullName: string | null;
  role: string;
  joinedAt: string;
}

export interface AssignableRole {
  key: string;
  label: string;
  description: string | null;
}

interface MembersViewProps {
  workspaceId: string;
  members: MemberRow[];
  /** Empty when the viewer may not manage membership — the source of truth is
   * `assignable_roles`, which returns nothing unless the caller holds
   * member.manage and applies the rank ceiling on top. */
  assignableRoles: AssignableRole[];
  currentUserId: string;
  roleLabels: Record<string, string>;
}

export function MembersView({
  workspaceId,
  members,
  assignableRoles,
  currentUserId,
  roleLabels,
}: MembersViewProps) {
  const [pending, startTransition] = useTransition();
  const canManage = assignableRoles.length > 0;

  // Same fire-and-toast shape as AsyncButton/ConfirmActionButton: the action
  // is called directly rather than through a <form action>, which is fine
  // because it does not redirect (see CLAUDE.md on redirecting actions).
  function onRoleChange(userId: string, role: string) {
    startTransition(async () => {
      await toast
        .promise(changeWorkspaceMemberRole(workspaceId, userId, role), {
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
        <CardTitle>Workspace members</CardTitle>
        <CardDescription>
          {canManage
            ? "People with access to this workspace. Admins manage client spaces, projects and people — they do not read client activity."
            : "People with access to this workspace. Only workspace admins can change roles."}
        </CardDescription>
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
                        action={removeWorkspaceMember.bind(null, workspaceId, member.userId)}
                        triggerLabel="Remove"
                        confirmLabel="Remove"
                        loadingMessage="Removing…"
                        title="Remove from this workspace?"
                        description={`${member.email} loses access to this workspace. They stay on the organisation roster and keep any client-space access granted separately.`}
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
