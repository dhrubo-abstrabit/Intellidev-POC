"use client";

import { useTransition } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";

const INHERIT = "__inherit__";

export interface ProjectRoleRow {
  userId: string;
  email: string;
  /** null = no override; inherits whatever their space role grants. */
  projectRole: string | null;
}

interface Props {
  projectName: string;
  rows: ProjectRoleRow[];
  roles: { key: string; label: string }[];
  /** Bound Server Action — `.bind(null, spaceId, projectId)`, never an arrow. */
  setRoleAction: (userId: string, role: string | null) => Promise<{ message: string }>;
  canManage: boolean;
}

/**
 * Per-project role overrides for people who already have space access.
 *
 * Overrides ADD to the space baseline, they do not subtract — see
 * setProjectRole's comment. So "Inherit" is the normal state and the right
 * default; a project role is only worth setting when someone needs *more* on
 * this project than their space role gives them.
 */
export function ProjectRoles({ projectName, rows, roles, setRoleAction, canManage }: Props) {
  const [pending, startTransition] = useTransition();

  function onChange(userId: string, value: string) {
    startTransition(async () => {
      await toast
        .promise(setRoleAction(userId, value === INHERIT ? null : value), {
          loading: "Updating…",
          success: (r) => r.message,
          error: (err) => (err instanceof Error ? err.message : "Could not update this project role."),
        })
        .catch(() => {});
    });
  }

  if (!canManage) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Project roles — {projectName}</CardTitle>
        <CardDescription>
          Optional. A project role grants more than someone&apos;s client-space role on this project; it never grants
          less. Leave everyone on Inherit unless one person needs extra access here.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Email</TableHead>
              <TableHead>Project role</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.userId}>
                <TableCell className="font-medium">{row.email}</TableCell>
                <TableCell>
                  <Select
                    value={row.projectRole ?? INHERIT}
                    onValueChange={(v) => {
                      if (typeof v === "string" && v !== (row.projectRole ?? INHERIT)) onChange(row.userId, v);
                    }}
                    disabled={pending}
                  >
                    <SelectTrigger className="w-52" aria-label={`Project role for ${row.email}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={INHERIT}>Inherit from client space</SelectItem>
                      {roles.map((r) => (
                        <SelectItem key={r.key} value={r.key}>
                          {r.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
