"use client";

import { useEffect, useState } from "react";

const TAGLINES = [
  "Turn conversations into action.",
  "Never miss a blocker.",
  "One inbox for your whole team.",
];

/** Cycles through a few taglines under the auth panel's wordmark. Remounting
 * the <p> on each change (via `key`) re-triggers globals.css's
 * animate-auth-fade-up on every switch instead of needing a second
 * crossfade animation just for this. */
export function AuthTagline({ initialDelayMs = 0 }: { initialDelayMs?: number }) {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setIndex((current) => (current + 1) % TAGLINES.length), 3500);
    return () => clearInterval(id);
  }, []);

  return (
    <p
      key={index}
      className="animate-auth-fade-up max-w-xs text-lg text-brand-n-800/80"
      style={index === 0 ? { animationDelay: `${initialDelayMs}ms` } : undefined}
    >
      {TAGLINES[index]}
    </p>
  );
}
