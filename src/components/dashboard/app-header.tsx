import type { ReactNode } from "react";
import { signOut } from "@/app/(auth)/actions";
import { Button } from "@/components/ui/button";

/** Rendered once per top-level route rather than from a single shared
 * layout: (app)/layout.tsx wraps both /onboarding (no workspace yet) and
 * /w/[workspaceId] (which is the only place workspace data is available to
 * fetch), so there's no single layout that can own both the header and the
 * workspace switcher without a parallel-routes slot. Two call sites of this
 * component is simpler than that. */
export function AppHeader({ workspaceSwitcher }: { workspaceSwitcher?: ReactNode }) {
  return (
    <header className="flex items-center justify-between border-b px-6 py-3">
      <div className="flex items-center gap-4">
        <span className="font-semibold">Intellidev</span>
        {workspaceSwitcher}
      </div>
      <form action={signOut}>
        <Button type="submit" variant="ghost" size="sm">
          Sign out
        </Button>
      </form>
    </header>
  );
}
