"use client";

import Link from "next/link";
import type { ComponentProps } from "react";
import { usePathname, useSearchParams } from "next/navigation";

/** Sets ?item=<id> on the current URL, preserving every other param — the
 * task detail sheet opens/closes purely off that param (see page.tsx /
 * task-detail-sheet.tsx), so this is the one place that constructs the URL
 * for it. */
export function OpenTaskLink({
  itemId,
  ...props
}: { itemId: string } & Omit<ComponentProps<typeof Link>, "href">) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const params = new URLSearchParams(searchParams.toString());
  params.set("item", itemId);

  return <Link href={`${pathname}?${params.toString()}`} {...props} />;
}
