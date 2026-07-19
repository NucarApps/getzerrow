import { useState } from "react";
import { ChevronDown, Pencil } from "lucide-react";
import { CompanyLogo } from "./CompanyLogo";
import { Checkbox } from "@/components/ui/checkbox";

type Props = {
  domain: string | null;
  name: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  onEdit?: () => void;
  aliasCount?: number;
  logoProvider?: number | null;
  logoSourceDomain?: string | null;
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
  onEdit,
  aliasCount = 0,
  logoProvider = null,
  logoSourceDomain = null,
  selectable = false,
  selectionState = "none",
  onToggleSelectAll,
}: Props) {
  const [color, setColor] = useState<string | null>(null);

  const tinted = !!(color && domain);
  const style = tinted
    ? {
        backgroundColor: `color-mix(in oklab, ${color} 14%, transparent)`,
        borderColor: `color-mix(in oklab, ${color} 35%, transparent)`,
      }
    : undefined;

  return (
    <div
      style={style}
      className={`flex w-full items-center gap-3 border px-3 py-2.5 text-left transition-colors hover:bg-accent/40 ${
        tinted ? "" : "border-border bg-card/40"
      }`}
    >
      {selectable && (
        <Checkbox
          checked={
            selectionState === "all" ? true : selectionState === "some" ? "indeterminate" : false
          }
          onCheckedChange={() => onToggleSelectAll?.()}
          onClick={(e) => e.stopPropagation()}
          aria-label={`Select all contacts in ${name}`}
        />
      )}
      <button onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <CompanyLogo
          domain={domain}
          name={name}
          size={32}
          onColor={setColor}
          provider={logoProvider}
          sourceDomain={logoSourceDomain}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-foreground">{name}</div>
          <div className="truncate text-xs text-muted-foreground">
            {domain ? `${domain}${aliasCount > 0 ? ` +${aliasCount}` : ""} · ` : ""}
            {count} {count === 1 ? "contact" : "contacts"}
          </div>
        </div>
      </button>
      {onEdit && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
          aria-label={`Edit ${name} domains`}
          title="Edit company domains"
          className="grid h-7 w-7 place-items-center rounded text-muted-foreground hover:bg-background/40 hover:text-foreground"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
      )}
      <button
        onClick={onToggle}
        aria-label={collapsed ? "Expand" : "Collapse"}
        className="grid h-7 w-7 place-items-center text-muted-foreground"
      >
        <ChevronDown className={`h-4 w-4 transition-transform ${collapsed ? "-rotate-90" : ""}`} />
      </button>
    </div>
  );
}
