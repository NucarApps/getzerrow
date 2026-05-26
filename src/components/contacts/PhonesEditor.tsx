import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Phone, Plus, Star, Trash2 } from "lucide-react";

export type PhoneEntry = {
  label: string;
  number: string;
  is_primary: boolean;
};

const LABEL_OPTIONS = ["mobile", "work", "home", "other"] as const;

type Props = {
  value: PhoneEntry[];
  onChange: (next: PhoneEntry[]) => void;
};

export function PhonesEditor({ value, onChange }: Props) {
  function update(idx: number, patch: Partial<PhoneEntry>) {
    const next = value.map((p, i) => (i === idx ? { ...p, ...patch } : p));
    onChange(next);
  }

  function add() {
    const isFirst = value.length === 0;
    onChange([
      ...value,
      { label: "mobile", number: "", is_primary: isFirst },
    ]);
  }

  function remove(idx: number) {
    const wasPrimary = value[idx]?.is_primary;
    const next = value.filter((_, i) => i !== idx);
    if (wasPrimary && next.length > 0 && !next.some((p) => p.is_primary)) {
      next[0] = { ...next[0], is_primary: true };
    }
    onChange(next);
  }

  function makePrimary(idx: number) {
    onChange(value.map((p, i) => ({ ...p, is_primary: i === idx })));
  }

  return (
    <div>
      <Label className="mb-1 flex items-center gap-1.5 text-xs uppercase tracking-widest text-muted-foreground">
        <Phone className="h-3.5 w-3.5" /> Phones
      </Label>
      <div className="space-y-2">
        {value.length === 0 && (
          <p className="text-xs italic text-muted-foreground">No phone numbers yet.</p>
        )}
        {value.map((p, idx) => (
          <div key={idx} className="flex items-center gap-2">
            <Select value={p.label} onValueChange={(v) => update(idx, { label: v })}>
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
              type="tel"
              placeholder="+1 555 123 4567"
              value={p.number}
              onChange={(e) => update(idx, { number: e.target.value })}
            />
            <Button
              type="button"
              size="icon"
              variant={p.is_primary ? "default" : "ghost"}
              onClick={() => makePrimary(idx)}
              aria-label={p.is_primary ? "Primary phone" : "Make primary"}
              title={p.is_primary ? "Primary" : "Make primary"}
              className="shrink-0"
            >
              <Star className={`h-4 w-4 ${p.is_primary ? "fill-current" : ""}`} />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={() => remove(idx)}
              aria-label="Remove phone"
              className="shrink-0 text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={add} className="gap-1.5">
          <Plus className="h-3.5 w-3.5" /> Add phone
        </Button>
      </div>
    </div>
  );
}
