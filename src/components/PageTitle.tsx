import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Canonical page heading for authenticated app pages. Standardizes the
 * `font-display text-2xl text-foreground` treatment so page titles are a
 * uniform size (previously text-lg → text-4xl across pages). Pass `className`
 * for layout-only tweaks (e.g. `truncate` inside a flex header).
 */
export function PageTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h1 className={cn("font-display text-2xl text-foreground", className)} {...props} />;
}
