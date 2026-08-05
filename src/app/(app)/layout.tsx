import { requireUser } from "@/lib/auth";
import { Toaster } from "@/components/ui/toast";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Defense in depth: proxy.ts already redirects unauthenticated requests
  // away from /w and /onboarding, but Server Actions rendered by pages under
  // this layout aren't gated by proxy at all (see proxy.ts's comment) —
  // this call is what actually enforces the boundary for this whole subtree.
  await requireUser();

  // No header here: it's rendered by each child route instead (see
  // components/dashboard/app-header.tsx) since only they know whether a
  // workspace switcher belongs beside it.
  return (
    <div className="min-h-screen">
      <main>{children}</main>
      <Toaster />
    </div>
  );
}
