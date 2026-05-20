import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Trash2, ShieldOff } from "lucide-react";
import { toast } from "sonner";

type Override = {
  id: string;
  match_type: "email" | "domain";
  value: string;
  note: string | null;
  created_at: string;
};

export function InboxOverrides() {
  const qc = useQueryClient();
  const [matchType, setMatchType] = useState<"email" | "domain">("email");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  const q = useQuery({
    queryKey: ["inbox-overrides"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("inbox_overrides")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as Override[];
    },
  });

  async function add() {
    const v = value.trim().toLowerCase();
    if (!v) return;
    if (matchType === "email" && !v.includes("@")) {
      toast.error("Enter a full email address");
      return;
    }
    if (matchType === "domain" && v.includes("@")) {
      toast.error("Enter a domain only (e.g. example.com)");
      return;
    }
    setBusy(true);
    const { data: u } = await supabase.auth.getUser();
    if (!u.user) { setBusy(false); toast.error("Not signed in"); return; }
    const { error } = await supabase
      .from("inbox_overrides")
      .insert({ user_id: u.user.id, match_type: matchType, value: v });
    setBusy(false);
    if (error) { toast.error(error.message); return; }
    setValue("");
    toast.success(`Added ${v} to your inbox list`);
    qc.invalidateQueries({ queryKey: ["inbox-overrides"] });
  }

  async function remove(id: string) {
    const { error } = await supabase.from("inbox_overrides").delete().eq("id", id);
    if (error) { toast.error(error.message); return; }
    qc.invalidateQueries({ queryKey: ["inbox-overrides"] });
  }

  const rows = q.data ?? [];

  return (
    <Card className="p-4 md:p-6">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <ShieldOff className="h-4 w-4 text-destructive" />
          <h2 className="font-display text-2xl">Always send to inbox</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Senders on this list skip folder rules and AI sorting. New mail from them stays in your inbox.
          Manually applied Gmail labels still win.
        </p>
      </div>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <Select value={matchType} onValueChange={(v) => setMatchType(v as "email" | "domain")}>
          <SelectTrigger className="sm:w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="email">Email address</SelectItem>
            <SelectItem value="domain">Domain</SelectItem>
          </SelectContent>
        </Select>
        <Input
          className="flex-1"
          placeholder={matchType === "email" ? "ceo@chevrolet.com" : "chevrolet.com"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") add(); }}
        />
        <Button onClick={add} disabled={busy}>{busy ? "Adding…" : "Add"}</Button>
      </div>

      <div className="mt-4 space-y-1.5">
        {rows.length === 0 && (
          <p className="text-sm italic text-muted-foreground">No overrides yet.</p>
        )}
        {rows.map((r) => (
          <div
            key={r.id}
            className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-1.5 text-sm"
          >
            <span className="rounded-sm bg-destructive/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-destructive">
              {r.match_type}
            </span>
            <span className="flex-1 font-mono text-xs">{r.value}</span>
            <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => remove(r.id)}>
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
        ))}
      </div>
    </Card>
  );
}
