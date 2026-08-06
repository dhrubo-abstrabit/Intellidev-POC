import { requireUser } from "@/lib/auth";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CreateWorkspaceForm } from "@/components/dashboard/create-workspace-form";
import { AppHeader } from "@/components/dashboard/app-header";

export default async function OnboardingPage() {
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
