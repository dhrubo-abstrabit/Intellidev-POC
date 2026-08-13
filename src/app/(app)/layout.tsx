import { requireUser } from "@/lib/auth";
import { Toaster } from "@/components/ui/toast";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Defense in depth: proxy.ts already redirects unauthenticated requests
  // away from /w and /onboarding, but Server Actions rendered by pages under
  // this layout aren't gated by proxy at all (see proxy.ts's comment) —
  // this call is what actually enforces the boundary for this whole subtree.
  await requireUser();

  // No header here: /onboarding renders its own bare AppHeader (no workspace
  // exists yet), and /w/[workspaceId] renders WorkspaceSidebar instead,
  // which needs workspace/project data this layout doesn't have.
  return (
    <div className="min-h-screen bg-brand-n-50">
      <main>{children}</main>
      <Toaster />
    </div>
  );
}
