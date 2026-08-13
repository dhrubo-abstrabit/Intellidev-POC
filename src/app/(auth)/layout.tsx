import { Inter, Inter_Tight } from "next/font/google";

// Scoped to the auth pages only (not the root layout's Geist) — the brand
// system (D:\Build_TM\brand-system.html) specifies Inter/Inter Tight, and
// this redesign is rolling out page by page rather than swapping the whole
// app's typeface in one shot.
const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const interTight = Inter_Tight({ subsets: ["latin"], weight: ["600", "700", "800"], variable: "--font-inter-tight" });

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    // h-screen + overflow-hidden (not min-h-screen): a fixed-height row, so
    // neither column can stretch the page taller than the viewport. Content
    // on the right that doesn't fit gets its own internal scroll instead.
    <div className={`${inter.variable} ${interTight.variable} flex h-screen overflow-hidden font-[family-name:var(--font-inter)]`}>
      {/* Decorative brand panel — hidden below md. One soft diagonal shape
       * over a light gradient, kept within the same teal family (no dark
       * tones) per the reference's overall feel — hand-built, not traced
       * from source art. h-full here needs the parent's fixed h-screen
       * above to resolve correctly; without it the SVG's intrinsic
       * viewBox aspect ratio takes over and the panel (and page) stretches
       * far taller than the viewport. */}
      <div className="relative hidden h-full overflow-hidden md:block md:w-1/2">
        <svg viewBox="0 0 500 900" preserveAspectRatio="none" className="h-full w-full" aria-hidden="true">
          <defs>
            <linearGradient id="auth-bg-base" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="var(--brand-teal-100)" />
              <stop offset="100%" stopColor="var(--brand-teal-400)" />
            </linearGradient>
          </defs>

          <rect x="0" y="0" width="500" height="900" fill="url(#auth-bg-base)" />

          {/* One diagonal sweep, same teal family as the base (teal-500) —
           * not a darker/contrasting accent, just enough shade shift to
           * read as a distinct layer. */}
          <ellipse cx="230" cy="470" rx="430" ry="200" transform="rotate(-35 230 470)" fill="var(--brand-teal-500)" />
        </svg>
      </div>

      <div className="flex h-full w-full flex-col items-center justify-center overflow-y-auto px-6 py-12 md:w-1/2">
        <div className="mb-10 text-xl font-[family-name:var(--font-inter-tight)] font-extrabold text-brand-n-900">
          Intelli<span className="text-brand-teal-600">Dev</span>
        </div>
        <div className="w-full max-w-sm">{children}</div>
      </div>
    </div>
  );
}
