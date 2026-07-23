import * as React from "react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export interface NavItemProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon;
  label: React.ReactNode;
  active?: boolean;
}

/**
 * Sidebar navigation row. Encapsulates the shared flex/rounded/hover styling
 * and active-state treatment used across the app-shell nav.
 */
export function NavItem({ icon: Icon, label, active = false, className, ...props }: NavItemProps) {
  return (
    <button
      type="button"
      className={cn(
        "flex items-center gap-3 rounded-md px-3 py-2 text-left text-sm text-sidebar-foreground hover:bg-sidebar-accent/60",
        active && "bg-sidebar-accent text-sidebar-accent-foreground",
        className,
      )}
      {...props}
    >
      <Icon className="h-4 w-4" /> {label}
    </button>
  );
}
