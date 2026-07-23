import * as React from "react";
import { Loader2 } from "lucide-react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const spinnerVariants = cva("animate-spin", {
  variants: {
    size: {
      xs: "h-3 w-3",
      sm: "h-4 w-4",
      md: "h-5 w-5",
      lg: "h-6 w-6",
    },
  },
  defaultVariants: {
    size: "sm",
  },
});

export interface SpinnerProps
  extends React.HTMLAttributes<SVGSVGElement>, VariantProps<typeof spinnerVariants> {}

export function Spinner({ className, size, ...props }: SpinnerProps) {
  return <Loader2 className={cn(spinnerVariants({ size }), className)} aria-hidden {...props} />;
}

/**
 * Spinner paired with a label — the recurring "flex items-center gap-2 …
 * <Loader2 animate-spin /> Loading…" row seen across settings/contacts.
 */
export function SpinnerLabel({
  children,
  size,
  className,
  spinnerClassName,
}: {
  children: React.ReactNode;
  size?: VariantProps<typeof spinnerVariants>["size"];
  className?: string;
  spinnerClassName?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2 text-sm text-muted-foreground", className)}>
      <Spinner size={size} className={spinnerClassName} />
      {children}
    </span>
  );
}
