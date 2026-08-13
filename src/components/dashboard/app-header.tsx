import { signOut } from "@/app/(auth)/actions";
import { Button } from "@/components/ui/button";
import { BrandMark } from "@/components/dashboard/brand-mark";

/** Chrome for routes with no workspace context yet (currently just
 * /onboarding) — everything under /w/[workspaceId] gets its nav from
 * WorkspaceSidebar instead, which needs workspace data this route doesn't
 * have. */
export function AppHeader() {
  return (
    <header className="flex items-center justify-between border-b border-brand-n-200 bg-brand-n-0 px-6 py-3">
      <BrandMark />
      <form action={signOut}>
        <Button type="submit" variant="ghost" size="sm" className="text-brand-n-600 hover:text-brand-n-900">
          Sign out
        </Button>
      </form>
    </header>
  );
}
