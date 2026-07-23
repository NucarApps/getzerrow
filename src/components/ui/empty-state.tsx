import * as React from "react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export interface EmptyStateProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  /** Optional lucide icon rendered above the text. */
  icon?: LucideIcon;
  /** Primary line. Falls back to `children` when omitted. */
  title?: React.ReactNode;
  /** Secondary, smaller line under the title. */
  description?: React.ReactNode;
  /** Optional action(s) (e.g. a Button) rendered below the text. */
  action?: React.ReactNode;
}

/**
 * Standard "No X yet / found" empty state — centered muted block.
 * Does not impose a Card wrapper; wrap in <Card> at the call-site when needed.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
  children,
  ...props
}: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-center px-4 py-8 text-center", className)} {...props}>
      {Icon && <Icon className="mb-3 h-8 w-8 text-muted-foreground" aria-hidden />}
      <p className="text-sm text-muted-foreground">{title ?? children}</p>
      {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
