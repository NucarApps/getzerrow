import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { ShieldOff, Plus, X, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  listRecordBlocklist,
  addRecordBlocklistEntry,
  removeRecordBlocklistEntry,
} from "@/lib/meetings.functions";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_RE = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/;

export function MeetingRecordBlocklistCard() {
  const qc = useQueryClient();
  const list = useServerFn(listRecordBlocklist);
  const add = useServerFn(addRecordBlocklistEntry);
  const remove = useServerFn(removeRecordBlocklistEntry);
  const [value, setValue] = useState("");

  const { data } = useQuery({
    queryKey: ["record-blocklist"],
    queryFn: () => list(),
  });

  const addMutation = useMutation({
    mutationFn: (v: string) => add({ data: { value: v } }),
    onSuccess: () => {
      setValue("");
      toast.success("Added to your don't-record list.");
      qc.invalidateQueries({ queryKey: ["record-blocklist"] });
    },
    onError: () => toast.error("Couldn't add that entry."),
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => remove({ data: { id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["record-blocklist"] }),
    onError: () => toast.error("Couldn't remove that entry."),
  });

  const handleAdd = () => {
    const v = value.trim().toLowerCase();
    if (!v) return;
    if (!EMAIL_RE.test(v) && !DOMAIN_RE.test(v)) {
      toast.error("Enter a valid email address or domain.");
      return;
    }
    addMutation.mutate(v);
  };

  const entries = data?.entries ?? [];

  return (
    <Card className="overflow-hidden p-0">
      <div className="flex items-start gap-3 border-b bg-muted/20 p-4 md:p-6">
        <ShieldOff className="mt-0.5 h-5 w-5 text-muted-foreground" />
        <div>
          <h2 className="font-display text-2xl">Don't record these people</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Meetings that include anyone on this list won't be recorded — not automatically, and
            not when you paste a link (as long as the meeting is on your calendar). Handy for calls
            with your attorney or anyone you'd rather keep off the record. Add a full email address,
            or a whole domain (for example, lawfirm.com) to skip everyone there.
          </p>
        </div>
      </div>

      <div className="space-y-4 p-4 md:p-6">
        <div className="flex gap-2">
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleAdd();
              }
            }}
            placeholder="jane@lawfirm.com or lawfirm.com"
            aria-label="Email or domain to never auto-record"
          />
          <Button onClick={handleAdd} disabled={addMutation.isPending}>
            {addMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <>
                <Plus className="h-4 w-4" />
                Add
              </>
            )}
          </Button>
        </div>

        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No one added yet. Everyone's meetings can be auto-recorded.
          </p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {entries.map((entry) => (
              <li
                key={entry.id}
                className="flex items-center gap-2 rounded-full border bg-muted/30 py-1 pl-3 pr-1 text-sm"
              >
                <span className="font-medium">{entry.value}</span>
                <button
                  type="button"
                  onClick={() => removeMutation.mutate(entry.id)}
                  className="rounded-full p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  aria-label={`Remove ${entry.value}`}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
