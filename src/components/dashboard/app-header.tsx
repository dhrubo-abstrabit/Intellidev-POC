import { signOut } from "@/app/(auth)/actions";
import { Button } from "@/components/ui/button";
import { BrandMark } from "@/components/dashboard/brand-mark";

/** Chrome for routes with no workspace context yet (currently just
 * /onboarding) — everything under /w/[workspaceId] gets its nav from
 * WorkspaceSidebar instead, which needs workspace data this route doesn't
 * have. */
export function AppHeader() {
  return (
    <header className="flex items-center justify-between border-b border-border bg-card px-6 py-3">
      <BrandMark />
      <form action={signOut}>
        <Button type="submit" variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground">
          Sign out
        </Button>
      </form>
    </header>
  );
}
