import { requireUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { can, tenantScope } from "@/lib/authz";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CreateWorkspaceForm } from "@/components/dashboard/create-workspace-form";
import { AppHeader } from "@/components/dashboard/app-header";

export default async function OnboardingPage() {
  // This page serves two audiences: someone with no organisation at all
  // (first run), and an owner adding another workspace to the one they have.
  //
  // The gate is the PERMISSION, not the existence of a tenant. Gating on
  // "has a tenant" locked owners out of creating a second workspace; gating on
  // nothing at all let an invited billing admin create an organisation of
  // their own and orphan the membership they had just accepted. Only someone
  // who can actually create a workspace should see the form.
  const supabase = await createClient();
  const { data: tenant } = await supabase.from("tenants").select("id").limit(1).maybeSingle();
  if (tenant && !(await can("workspace.create", tenantScope(tenant.id)))) {
    redirect("/org");
  }

  await requireUser();

  return (
    <>
      <AppHeader />
      <div className="flex min-h-[80vh] items-center justify-center p-4">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Create your workspace</CardTitle>
            <CardDescription>A workspace holds your projects and their connected integrations.</CardDescription>
          </CardHeader>
          <CardContent>
            <CreateWorkspaceForm />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
