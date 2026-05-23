import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { CompanyLogo } from "./CompanyLogo";

type Props = {
  domain: string | null;
  name: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
};

export function CompanyBucketHeader({ domain, name, count, collapsed, onToggle }: Props) {
  const [color, setColor] = useState<string | null>(null);

  const tinted = !!(color && domain);
  const style = tinted
    ? {
        backgroundColor: `color-mix(in oklab, ${color} 14%, transparent)`,
        borderColor: `color-mix(in oklab, ${color} 35%, transparent)`,
      }
    : undefined;

  return (
    <button
      onClick={onToggle}
      style={style}
      className={`flex w-full items-center gap-3 border px-3 py-2.5 text-left transition-colors hover:bg-accent/40 ${
        tinted ? "" : "border-border bg-card/40"
      }`}
    >
      <CompanyLogo domain={domain} name={name} size={32} onColor={setColor} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold text-foreground">{name}</div>
        <div className="truncate text-xs text-muted-foreground">
          {domain ? `${domain} · ` : ""}{count} {count === 1 ? "contact" : "contacts"}
        </div>
      </div>
      <ChevronDown
        className={`h-4 w-4 text-muted-foreground transition-transform ${collapsed ? "-rotate-90" : ""}`}
      />
    </button>
  );
}
