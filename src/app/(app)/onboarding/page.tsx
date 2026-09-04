import { requireUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CreateWorkspaceForm } from "@/components/dashboard/create-workspace-form";
import { AppHeader } from "@/components/dashboard/app-header";

export default async function OnboardingPage() {
  // Onboarding creates a NEW tenant (create_tenant_and_workspace). Anyone who
  // already belongs to one must never reach it: a billing admin who did ended
  // up owning a second organisation, with the membership they were invited to
  // orphaned and invisible.
  const supabase = await createClient();
  const { data: tenant } = await supabase.from("tenants").select("id").limit(1).maybeSingle();
  if (tenant) redirect("/org");

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
