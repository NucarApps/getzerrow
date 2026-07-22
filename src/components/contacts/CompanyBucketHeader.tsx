import { useState } from "react";
import { ChevronDown, ArrowUpRight, Loader2 } from "lucide-react";
import { CompanyLogo } from "./CompanyLogo";
import { Checkbox } from "@/components/ui/checkbox";

type Props = {
  domain: string | null;
  name: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  /** Navigate to (or create then open) this company's page. */
  onOpen?: () => void;
  opening?: boolean;
  aliasCount?: number;
  logoProvider?: number | null;
  logoSourceDomain?: string | null;
  /** Custom uploaded company logo URL (wins over the brand logo). */
  photoUrl?: string | null;
  /** Reports the dominant logo color so the parent can tint member rows. */
  onColor?: (color: string) => void;
  selectable?: boolean;
  selectionState?: "none" | "some" | "all";
  onToggleSelectAll?: () => void;
};

export function CompanyBucketHeader({
  domain,
  name,
  count,
  collapsed,
  onToggle,
  onOpen,
  opening = false,
  aliasCount = 0,
  logoProvider = null,
  logoSourceDomain = null,
  photoUrl = null,
  onColor,
  selectable = false,
  selectionState = "none",
  onToggleSelectAll,
}: Props) {
  const [color, setColor] = useState<string | null>(null);

  // Sticky section header: the background must be opaque (mixed against the
  // page's deep-space base, not transparent) or rows would ghost through
  // while the header is pinned during scroll.
  const tinted = !!(color && domain);
  const style = tinted
    ? {
        backgroundColor: `color-mix(in oklab, ${color} 14%, #0d1220)`,
        borderColor: `color-mix(in oklab, ${color} 35%, transparent)`,
      }
    : undefined;

  return (
    <div
      style={style}
      className={`sticky top-0 z-[5] flex w-full items-center gap-2.5 border-b px-4 py-4 text-left transition-colors sm:py-1.5 ${
        tinted ? "" : "border-border bg-[#0d1220]"
      }`}

    >
      {selectable && (
        <Checkbox
          className="h-4 w-4 sm:h-3.5 sm:w-3.5"
          checked={
            selectionState === "all" ? true : selectionState === "some" ? "indeterminate" : false
          }
          onCheckedChange={() => onToggleSelectAll?.()}
          onClick={(e) => e.stopPropagation()}
          aria-label={`Select all contacts in ${name}`}
        />
      )}
      <button onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
        <div className="sm:hidden">
          <CompanyLogo
            domain={domain}
            name={name}
            size={28}
            onColor={(c) => {
              setColor(c);
              if (c) onColor?.(c);
            }}
            provider={logoProvider}
            sourceDomain={logoSourceDomain}
            photoUrl={photoUrl}
          />
        </div>
        <div className="hidden sm:block">
          <CompanyLogo
            domain={domain}
            name={name}
            size={22}
            onColor={(c) => {
              setColor(c);
              if (c) onColor?.(c);
            }}
            provider={logoProvider}
            sourceDomain={logoSourceDomain}
            photoUrl={photoUrl}
          />
        </div>
        <span className="truncate text-[13px] font-semibold uppercase tracking-[0.08em] text-foreground/90 sm:text-[11px]">
          {name}
        </span>
        <span className="truncate text-xs text-muted-foreground sm:text-[11px]">
          {domain ? `${domain}${aliasCount > 0 ? ` +${aliasCount}` : ""} · ` : ""}
          {count}
        </span>
      </button>
      {onOpen && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (!opening) onOpen();
          }}
          disabled={opening}
          aria-label={`Open ${name}`}
          title="Open company page"
          className="grid h-8 w-8 shrink-0 place-items-center rounded text-muted-foreground hover:bg-background/40 hover:text-primary disabled:opacity-50 sm:h-6 sm:w-6"
        >
          {opening ? (
            <Loader2 className="h-4 w-4 animate-spin sm:h-3.5 sm:w-3.5" />
          ) : (
            <ArrowUpRight className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
          )}
        </button>
      )}
      <button
        onClick={onToggle}
        aria-label={collapsed ? "Expand" : "Collapse"}
        className="grid h-8 w-8 shrink-0 place-items-center text-muted-foreground sm:h-6 sm:w-6"
      >
        <ChevronDown className={`h-5 w-5 transition-transform sm:h-4 sm:w-4 ${collapsed ? "-rotate-90" : ""}`} />
      </button>
    </div>
  );
}

