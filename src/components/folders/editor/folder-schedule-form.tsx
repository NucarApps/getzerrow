import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import type { Schedule } from "./types";

export const browserTz = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
})();

export function pad2(n: number) {
  return n < 10 ? `0${n}` : String(n);
}

export function ScheduleForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: Schedule;
  onSave: (vals: {
    name: string;
    instructions: string;
    hour: number;
    minute: number;
    timezone: string;
  }) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "Daily digest");
  const [instructions, setInstructions] = useState(initial?.instructions ?? "");
  const [hour, setHour] = useState(initial?.hour ?? 8);
  const [minute, setMinute] = useState(initial?.minute ?? 0);
  const [tz, setTz] = useState(initial?.timezone ?? browserTz);
  const [saving, setSaving] = useState(false);

  const MAX_INSTRUCTIONS = 50000;
  const instructionsLen = instructions.length;
  const overLimit = instructionsLen > MAX_INSTRUCTIONS;

  async function submit() {
    if (!name.trim()) {
      toast.error("Name required");
      return;
    }
    if (overLimit) {
      toast.error(
        `Instructions are too long (${instructionsLen.toLocaleString()} / ${MAX_INSTRUCTIONS.toLocaleString()})`,
      );
      return;
    }
    setSaving(true);
    try {
      await onSave({
        name: name.trim(),
        instructions: instructions.trim(),
        hour,
        minute,
        timezone: tz.trim() || "UTC",
      });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-md border border-border bg-background p-3 space-y-2.5">
      <div>
        <Label className="text-xs uppercase tracking-wider text-muted-foreground">Name</Label>
        <Input
          className="mt-1"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Morning newsletter digest"
        />
      </div>
      <div className="grid grid-cols-[1fr_1fr_1.5fr] gap-2">
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground">Hour</Label>
          <Select value={String(hour)} onValueChange={(v) => setHour(parseInt(v, 10))}>
            <SelectTrigger className="mt-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Array.from({ length: 24 }).map((_, i) => (
                <SelectItem key={i} value={String(i)}>
                  {pad2(i)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground">Minute</Label>
          <Select value={String(minute)} onValueChange={(v) => setMinute(parseInt(v, 10))}>
            <SelectTrigger className="mt-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[0, 15, 30, 45].map((i) => (
                <SelectItem key={i} value={String(i)}>
                  {pad2(i)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground">Timezone</Label>
          <Input
            className="mt-1"
            value={tz}
            onChange={(e) => setTz(e.target.value)}
            placeholder="America/New_York"
          />
        </div>
      </div>
      <div>
        <div className="flex items-center justify-between">
          <Label className="text-xs uppercase tracking-wider text-muted-foreground">
            Instructions
          </Label>
          <span
            className={`text-[10px] tabular-nums ${overLimit ? "text-destructive" : "text-muted-foreground"}`}
          >
            {instructionsLen.toLocaleString()} / {MAX_INSTRUCTIONS.toLocaleString()}
          </span>
        </div>
        <Textarea
          className="mt-1"
          rows={6}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="Group by sender, surface action items, keep it under 10 bullets."
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button size="sm" onClick={submit} disabled={saving || overLimit}>
          {saving ? "Saving…" : initial ? "Save" : "Create"}
        </Button>
      </div>
    </div>
  );
}
