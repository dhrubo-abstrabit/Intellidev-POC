"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * `useTheme()`'s `resolvedTheme` is undefined until after mount (next-themes
 * can't know the system/stored preference during SSR) — rendering a neutral
 * icon until then avoids briefly flashing the wrong one, and avoids a
 * hydration mismatch between server and client markup.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  // Mount-detection is the documented next-themes pattern for this exact
  // problem (resolvedTheme is genuinely unknown until the client hydrates)
  // — there's no prop/external-system value to derive this from during
  // render, so it can only be set once, after mount, in an effect.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setMounted(true), []);

  const isDark = mounted && resolvedTheme === "dark";

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={mounted ? (isDark ? "Switch to light mode" : "Switch to dark mode") : "Toggle theme"}
      onClick={() => setTheme(isDark ? "light" : "dark")}
      className={cn("text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground", className)}
    >
      {mounted && isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  );
}
