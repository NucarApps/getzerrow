import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Mail, Plus, Star, Trash2 } from "lucide-react";

export type EmailEntry = {
  label: string;
  address: string;
  is_primary: boolean;
};

const LABEL_OPTIONS = ["work", "home", "other"] as const;

type Props = {
  value: EmailEntry[];
  onChange: (next: EmailEntry[]) => void;
};

export function EmailsEditor({ value, onChange }: Props) {
  function update(idx: number, patch: Partial<EmailEntry>) {
    onChange(value.map((e, i) => (i === idx ? { ...e, ...patch } : e)));
  }
  function add() {
    const isFirst = value.length === 0;
    onChange([...value, { label: "work", address: "", is_primary: isFirst }]);
  }
  function remove(idx: number) {
    const wasPrimary = value[idx]?.is_primary;
    const next = value.filter((_, i) => i !== idx);
    if (wasPrimary && next.length > 0 && !next.some((e) => e.is_primary)) {
      next[0] = { ...next[0], is_primary: true };
    }
    onChange(next);
  }
  function makePrimary(idx: number) {
    onChange(value.map((e, i) => ({ ...e, is_primary: i === idx })));
  }

  return (
    <div>
      <Label className="mb-1 flex items-center gap-1.5 text-xs uppercase tracking-widest text-muted-foreground">
        <Mail className="h-3.5 w-3.5" /> Emails
      </Label>
      <div className="space-y-2">
        {value.length === 0 && (
          <p className="text-xs italic text-muted-foreground">No email addresses yet.</p>
        )}
        {value.map((em, idx) => (
          <div key={idx} className="flex items-center gap-2">
            <Select value={em.label} onValueChange={(v) => update(idx, { label: v })}>
              <SelectTrigger className="w-[110px] shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LABEL_OPTIONS.map((opt) => (
                  <SelectItem key={opt} value={opt}>
                    {opt.charAt(0).toUpperCase() + opt.slice(1)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              className="flex-1"
              type="email"
              placeholder="name@example.com"
              value={em.address}
              onChange={(e) => update(idx, { address: e.target.value })}
            />
            <Button
              type="button"
              size="icon"
              variant={em.is_primary ? "default" : "ghost"}
              onClick={() => makePrimary(idx)}
              aria-label={em.is_primary ? "Primary email" : "Make primary"}
              title={em.is_primary ? "Primary" : "Make primary"}
              className="shrink-0"
            >
              <Star className={`h-4 w-4 ${em.is_primary ? "fill-current" : ""}`} />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={() => remove(idx)}
              aria-label="Remove email"
              className="shrink-0 text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={add} className="gap-1.5">
          <Plus className="h-3.5 w-3.5" /> Add email
        </Button>
      </div>
    </div>
  );
}
