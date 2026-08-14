import { AuthTagline } from "@/components/auth/auth-tagline";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    // h-screen + overflow-hidden (not min-h-screen): a fixed-height row, so
    // neither column can stretch the page taller than the viewport. Content
    // on the right that doesn't fit gets its own internal scroll instead.
    <div className="flex h-screen overflow-hidden">
      {/* Decorative brand panel — hidden below md. Layered overlapping
       * "hill" arcs (large circles cresting above a horizon), lightest at
       * back to darkest in front, per the reference design — kept within
       * the same teal family, hand-built, not traced from source art.
       * h-full here needs the parent's fixed h-screen above to resolve
       * correctly; without it the SVG's intrinsic viewBox aspect ratio
       * takes over and the panel (and page) stretches far taller than the
       * viewport. */}
      <div className="relative hidden h-full overflow-hidden md:block md:w-1/2">
        <svg viewBox="0 0 500 900" preserveAspectRatio="none" className="h-full w-full" aria-hidden="true">
          <defs>
            <linearGradient id="auth-bg-sky" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--brand-teal-50)" />
              <stop offset="100%" stopColor="var(--brand-teal-200)" />
            </linearGradient>
          </defs>

          <rect x="0" y="0" width="500" height="900" fill="url(#auth-bg-sky)" />

          {/* Back to front: lightest/furthest hill painted first so the
           * darker, closer ones layer on top of it. Kept low enough that
           * every hill's crest stays below the panel's vertical center
           * (y=450, where the wordmark/tagline overlay is centered) — the
           * reference image has no text to protect there, ours does. */}
          <circle cx="410" cy="890" r="330" fill="var(--brand-teal-200)" />
          <circle cx="90" cy="890" r="300" fill="var(--brand-teal-300)" />
          <circle cx="260" cy="1030" r="350" fill="var(--brand-teal-400)" />
        </svg>

        <div className="absolute inset-0 flex flex-col items-center justify-center px-12 text-center">
          <div
            className="animate-auth-fade-up font-heading text-6xl font-extrabold text-brand-n-900 lg:text-7xl"
            style={{ animationDelay: "100ms" }}
          >
            Intelli<span className="text-brand-teal-700">Dev</span>
          </div>
          <div className="mt-6">
            <AuthTagline initialDelayMs={300} />
          </div>
        </div>
      </div>

      <div className="flex h-full w-full flex-col items-center justify-center overflow-y-auto px-6 py-12 md:w-1/2">
        <div className="mb-10 font-heading text-3xl font-extrabold text-brand-n-900">
          Intelli<span className="text-brand-teal-600">Dev</span>
        </div>
        <div className="w-full max-w-sm">{children}</div>
      </div>
    </div>
  );
}
