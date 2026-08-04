"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

export default function ProjectError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto max-w-3xl space-y-3 py-12 text-center">
      <h2 className="text-lg font-semibold">Something went wrong</h2>
      <p className="text-sm text-muted-foreground">{error.message || "An unexpected error occurred."}</p>
      <Button onClick={() => reset()}>Try again</Button>
    </div>
  );
}
