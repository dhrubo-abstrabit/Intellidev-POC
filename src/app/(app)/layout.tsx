import { requireUser } from "@/lib/auth";
import { signOut } from "@/app/(auth)/actions";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/toast";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Defense in depth: proxy.ts already redirects unauthenticated requests
  // away from /w and /onboarding, but Server Actions rendered by pages under
  // this layout aren't gated by proxy at all (see proxy.ts's comment) —
  // this call is what actually enforces the boundary for this whole subtree.
  await requireUser();

  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between border-b px-6 py-3">
        <span className="font-semibold">Intellidev</span>
        <form action={signOut}>
          <Button type="submit" variant="ghost" size="sm">
            Sign out
          </Button>
        </form>
      </header>
      <main>{children}</main>
      <Toaster />
    </div>
  );
}
