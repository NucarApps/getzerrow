// Generic labelled-entries editor: a list of { label, value, is_primary }
// rows with a label Select, a value Input, make-primary star, remove, and
// add. EmailsEditor and PhonesEditor are thin wrappers around this — they
// used to be two structurally identical ~120-line components.
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
import { AlertCircle, Plus, Star, Trash2 } from "lucide-react";

export type EntryRow = { label: string; is_primary: boolean };

export function EntriesEditor<T extends EntryRow>({
  value,
  onChange,
  heading,
  headingIcon,
  labelOptions,
  defaultLabel,
  valueOf,
  withValue,
  inputType,
  placeholder,
  emptyText,
  addLabel,
  noun,
  validate,
}: {
  value: T[];
  onChange: (next: T[]) => void;
  heading: string;
  headingIcon: React.ReactNode;
  labelOptions: readonly string[];
  defaultLabel: string;
  /** Read the editable value field of an entry (address / number). */
  valueOf: (entry: T) => string;
  /** Build a new/updated entry with the given value field. */
  withValue: (entry: T | null, value: string, isPrimary: boolean, label: string) => T;
  inputType: string;
  placeholder: string;
  emptyText: string;
  addLabel: string;
  /** Singular noun for aria labels ("email", "phone"). */
  noun: string;
  /** Optional per-entry validation; return an error string to flag the row. */
  validate?: (raw: string) => string | null;
}) {
  function update(idx: number, patch: { label?: string; value?: string }) {
    onChange(
      value.map((e, i) => {
        if (i !== idx) return e;
        const nextLabel = patch.label ?? e.label;
        const nextValue = patch.value ?? valueOf(e);
        return withValue(e, nextValue, e.is_primary, nextLabel);
      }),
    );
  }
  function add() {
    const isFirst = value.length === 0;
    onChange([...value, withValue(null, "", isFirst, defaultLabel)]);
  }
  function remove(idx: number) {
    const wasPrimary = value[idx]?.is_primary;
    const next = value.filter((_, i) => i !== idx);
    if (wasPrimary && next.length > 0 && !next.some((e) => e.is_primary)) {
      next[0] = withValue(next[0], valueOf(next[0]), true, next[0].label);
    }
    onChange(next);
  }
  function makePrimary(idx: number) {
    onChange(value.map((e, i) => withValue(e, valueOf(e), i === idx, e.label)));
  }

  return (
    <div>
      <Label className="mb-1 flex items-center gap-1.5 text-xs uppercase tracking-widest text-muted-foreground">
        {headingIcon} {heading}
      </Label>
      <div className="space-y-2">
        {value.length === 0 && <p className="text-xs italic text-muted-foreground">{emptyText}</p>}
        {value.map((entry, idx) => {
          const raw = valueOf(entry);
          const error = raw.trim() && validate ? validate(raw) : null;
          const errorId = `${noun}-error-${idx}`;
          return (
            <div key={idx} className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <Select value={entry.label} onValueChange={(v) => update(idx, { label: v })}>
                  <SelectTrigger className="w-[110px] shrink-0">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {labelOptions.map((opt) => (
                      <SelectItem key={opt} value={opt}>
                        {opt.charAt(0).toUpperCase() + opt.slice(1)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  className={`flex-1 ${error ? "border-destructive focus-visible:ring-destructive" : ""}`}
                  type={inputType}
                  placeholder={placeholder}
                  value={raw}
                  onChange={(e) => update(idx, { value: e.target.value })}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? errorId : undefined}
                />
                <Button
                  type="button"
                  size="icon"
                  variant={entry.is_primary ? "default" : "ghost"}
                  onClick={() => makePrimary(idx)}
                  aria-label={entry.is_primary ? `Primary ${noun}` : "Make primary"}
                  title={entry.is_primary ? "Primary" : "Make primary"}
                  className="shrink-0"
                >
                  <Star className={`h-4 w-4 ${entry.is_primary ? "fill-current" : ""}`} />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  onClick={() => remove(idx)}
                  aria-label={`Remove ${noun}`}
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              {error && (
                <p
                  id={errorId}
                  className="flex items-center gap-1 pl-[118px] text-xs text-destructive"
                >
                  <AlertCircle className="h-3 w-3" />
                  {error}
                </p>
              )}
            </div>
          );
        })}
        <Button type="button" variant="outline" size="sm" onClick={add} className="gap-1.5">
          <Plus className="h-3.5 w-3.5" /> {addLabel}
        </Button>
      </div>
    </div>
  );
}
