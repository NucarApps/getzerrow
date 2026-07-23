import * as React from "react";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Rounded pill showing an optional color dot + label, with an optional remove
 * (×) button. Consolidates the hand-rolled `inline-flex … rounded-full border …`
 * chips repeated across contacts / email-decision views.
 */
export interface ColorDotChipProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, "color"> {
  /** CSS color for the leading dot. Omit to render no dot. */
  color?: string | null;
  /** When provided, renders a trailing × button that calls this on click. */
  onRemove?: () => void;
  /** Accessible label for the remove button. */
  removeLabel?: string;
}

export function ColorDotChip({
  color,
  onRemove,
  removeLabel,
  className,
  children,
  ...props
}: ColorDotChipProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-border bg-card/60 py-0.5 pl-2 text-xs",
        onRemove ? "pr-1" : "pr-2",
        className,
      )}
      {...props}
    >
      {color != null && (
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
      )}
      {children}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={removeLabel}
          className="grid h-4 w-4 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}
