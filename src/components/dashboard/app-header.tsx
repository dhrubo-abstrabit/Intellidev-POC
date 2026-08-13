import type { ReactNode } from "react";
import { signOut } from "@/app/(auth)/actions";
import { Button } from "@/components/ui/button";

/** Rendered once per top-level route rather than from a single shared
 * layout: (app)/layout.tsx wraps both /onboarding (no workspace yet) and
 * /w/[workspaceId] (which is the only place workspace data is available to
 * fetch), so there's no single layout that can own both the header and the
 * workspace switcher without a parallel-routes slot. Two call sites of this
 * component is simpler than that. */
export function AppHeader({ workspaceSwitcher, nav }: { workspaceSwitcher?: ReactNode; nav?: ReactNode }) {
  return (
    <header className="flex items-center justify-between border-b border-brand-n-200 bg-brand-n-0 px-6 py-3">
      <div className="flex items-center gap-4">
        <span className="font-heading font-extrabold text-brand-n-900">
          Intelli<span className="text-brand-teal-600">Dev</span>
        </span>
        {workspaceSwitcher}
        {nav ? (
          <div className="flex items-center gap-4 border-l border-brand-n-200 pl-4 text-sm text-brand-n-600">{nav}</div>
        ) : null}
      </div>
      <form action={signOut}>
        <Button type="submit" variant="ghost" size="sm" className="text-brand-n-600 hover:text-brand-n-900">
          Sign out
        </Button>
      </form>
    </header>
  );
}
