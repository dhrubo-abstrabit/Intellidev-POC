"use client";

import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ConfirmActionButton } from "@/components/dashboard/confirm-action-button";
import { TeamMemberDialog } from "@/app/(app)/w/[workspaceId]/team-members/team-member-dialog";
import { deleteTeamMember } from "@/app/(app)/w/[workspaceId]/team-members/actions";
import type { TeamMember } from "@/app/(app)/w/[workspaceId]/team-members/types";

interface TeamMembersViewProps {
  workspaceId: string;
  members: TeamMember[];
  canManage: boolean;
}

export function TeamMembersView({ workspaceId, members, canManage }: TeamMembersViewProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Team Members</CardTitle>
        {canManage ? (
          <CardAction>
            <TeamMemberDialog workspaceId={workspaceId} triggerLabel="Add team member" />
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent>
        {members.length === 0 ? (
          <p className="text-sm text-muted-foreground">No team members yet — add your first one.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Description</TableHead>
                {canManage ? <TableHead className="text-right">Actions</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((member) => (
                <TableRow key={member.id}>
                  <TableCell className="font-medium">{member.name}</TableCell>
                  <TableCell>{member.email}</TableCell>
                  <TableCell>{member.role ?? "—"}</TableCell>
                  <TableCell className="max-w-xs whitespace-normal text-muted-foreground">
                    {member.description ?? "—"}
                  </TableCell>
                  {canManage ? (
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <TeamMemberDialog
                          workspaceId={workspaceId}
                          member={member}
                          triggerLabel="Edit"
                          triggerVariant="outline"
                        />
                        <ConfirmActionButton
                          action={deleteTeamMember.bind(null, workspaceId, member.id)}
                          triggerLabel="Remove"
                          confirmLabel="Remove"
                          loadingMessage="Removing…"
                          title="Remove this team member?"
                          description={`This removes ${member.name} from the roster. This can't be undone.`}
                        />
                      </div>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
