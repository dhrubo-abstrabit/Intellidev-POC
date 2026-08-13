import { Inter, Inter_Tight } from "next/font/google";
import { requireUser } from "@/lib/auth";
import { Toaster } from "@/components/ui/toast";

// Same brand-system typefaces as (auth)/layout.tsx, scoped here rather than
// the root layout — the redesign is rolling out route-group by route-group.
const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const interTight = Inter_Tight({ subsets: ["latin"], weight: ["600", "700", "800"], variable: "--font-inter-tight" });

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
    <div className={`${inter.variable} ${interTight.variable} min-h-screen bg-brand-n-50 font-[family-name:var(--font-inter)]`}>
      <main>{children}</main>
      <Toaster />
    </div>
  );
}
