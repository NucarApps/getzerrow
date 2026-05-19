import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { learnFolderFromLabel, listFolderDomainSuggestions, addDomainFilter, reassignDomainToFolder } from "@/lib/gmail.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Plus, Trash2, X, Sparkles, Link2, ArrowRight } from "lucide-react";
import { toast } from "sonner";

export type Folder = {
  id: string;
  name: string;
  color: string;
  gmail_label_id: string | null;
  ai_rule: string | null;
  learned_profile: string | null;
  last_learned_at: string | null;
  auto_archive: boolean;
  auto_mark_read: boolean;
  priority: number;
  gmail_account_id: string;
};
export type Filter = { id: string; folder_id: string; field: string; op: string; value: string };
export type GLabel = { id: string; name: string; type: string };

export function FolderEditor({
  folder,
  labels,
  onDeleted,
}: {
  folder: Folder;
  labels: GLabel[];
  onDeleted?: () => void;
}) {
  const qc = useQueryClient();
  const learnFn = useServerFn(learnFolderFromLabel);
  const listDomainsFn = useServerFn(listFolderDomainSuggestions);
  const addDomainFn = useServerFn(addDomainFilter);
  const reassignFn = useServerFn(reassignDomainToFolder);
  const [local, setLocal] = useState(folder);
  const [pickerOpen, setPickerOpen] = useState<string | null>(null);
  const [newF, setNewF] = useState({ field: "from", op: "contains", value: "" });
  const [learning, setLearning] = useState(false);
  const dirty = JSON.stringify(local) !== JSON.stringify(folder);
  const linkedLabel = labels.find((l) => l.id === folder.gmail_label_id);

  const filtersQ = useQuery({
    queryKey: ["folder-filters", folder.id],
    queryFn: async () => {
      const { data } = await supabase.from("folder_filters").select("*").eq("folder_id", folder.id);
      return (data ?? []) as Filter[];
    },
  });
  const filters = filtersQ.data ?? [];

  const exampleCountQ = useQuery({
    queryKey: ["folder-example-count", folder.id],
    queryFn: async () => {
      const { count } = await supabase.from("folder_examples").select("id", { count: "exact", head: true }).eq("folder_id", folder.id);
      return count ?? 0;
    },
  });
  const exampleCount = exampleCountQ.data ?? 0;

  const domainsQ = useQuery({
    queryKey: ["folder-domains", folder.id, exampleCount],
    enabled: exampleCount > 0,
    queryFn: async () => (await listDomainsFn({ data: { folder_id: folder.id } })).suggestions,
    placeholderData: (prev) => prev,
  });

  const otherFoldersQ = useQuery({
    queryKey: ["folders-picker", folder.gmail_account_id, folder.id],
    queryFn: async () => {
      const { data } = await supabase
        .from("folders")
        .select("id, name, color")
        .eq("gmail_account_id", folder.gmail_account_id)
        .neq("id", folder.id)
        .order("name");
      return (data ?? []) as Array<{ id: string; name: string; color: string }>;
    },
  });

  async function save() {
    const { error } = await supabase.from("folders").update({
      name: local.name, color: local.color, ai_rule: local.ai_rule,
      gmail_label_id: local.gmail_label_id,
      auto_archive: local.auto_archive, auto_mark_read: local.auto_mark_read, priority: local.priority,
    }).eq("id", folder.id);
    if (error) { toast.error(error.message); return; }
    toast.success("Saved");
    qc.invalidateQueries({ queryKey: ["folders"] });
    qc.invalidateQueries({ queryKey: ["folders-full"] });
  }
  async function remove() {
    if (!confirm(`Delete "${folder.name}"?`)) return;
    await supabase.from("folders").delete().eq("id", folder.id);
    qc.invalidateQueries({ queryKey: ["folders"] });
    qc.invalidateQueries({ queryKey: ["folders-full"] });
    onDeleted?.();
  }
  async function addFilter() {
    if (!newF.value.trim()) return;
    await supabase.from("folder_filters").insert({ ...newF, folder_id: folder.id, value: newF.value.trim() });
    setNewF({ field: "from", op: "contains", value: "" });
    qc.invalidateQueries({ queryKey: ["folder-filters", folder.id] });
  }
  async function removeFilter(id: string) {
    await supabase.from("folder_filters").delete().eq("id", id);
    qc.invalidateQueries({ queryKey: ["folder-filters", folder.id] });
  }
  async function addDomain(domain: string) {
    const key = ["folder-domains", folder.id, exampleCount];
    const prev = qc.getQueryData<Array<{ domain: string; count: number }>>(key);
    qc.setQueryData(key, (old: Array<{ domain: string; count: number }> | undefined) =>
      (old ?? []).filter((s) => s.domain !== domain),
    );
    try {
      await addDomainFn({ data: { folder_id: folder.id, domain } });
      toast.success(`Now routing ${domain} → ${folder.name}`);
      qc.invalidateQueries({ queryKey: ["folder-filters", folder.id] });
      qc.invalidateQueries({ queryKey: ["folder-domains", folder.id] });
    } catch (e: any) {
      qc.setQueryData(key, prev);
      toast.error(e.message ?? "Failed to add");
    }
  }
  async function reassignDomain(domain: string, toFolderId: string, toName: string) {
    const key = ["folder-domains", folder.id, exampleCount];
    const prev = qc.getQueryData<Array<{ domain: string; count: number }>>(key);
    qc.setQueryData(key, (old: Array<{ domain: string; count: number }> | undefined) =>
      (old ?? []).filter((s) => s.domain !== domain),
    );
    setPickerOpen(null);
    try {
      const r = await reassignFn({ data: { from_folder_id: folder.id, to_folder_id: toFolderId, domain } });
      toast.success(`Moved ${r.moved} email${r.moved === 1 ? "" : "s"} to ${toName} · routing future ${domain}`);
      qc.invalidateQueries({ queryKey: ["emails"] });
      qc.invalidateQueries({ queryKey: ["folder-filters", toFolderId] });
      qc.invalidateQueries({ queryKey: ["folder-domains", folder.id] });
      qc.invalidateQueries({ queryKey: ["folders-full"] });
    } catch (e: any) {
      qc.setQueryData(key, prev);
      toast.error(e.message ?? "Failed to move");
    }
  }
  async function learn() {
    if (!folder.gmail_label_id) { toast.error("Link a Gmail label first, then save."); return; }
    setLearning(true);
    try {
      const r = await learnFn({ data: { folder_id: folder.id } });
      const bits: string[] = [];
      if (r.learned) bits.push(`learned from ${r.learned}`);
      if (r.ingested) bits.push(`imported ${r.ingested}`);
      if (r.claimed) bits.push(`tagged ${r.claimed}`);
      if (bits.length === 0) toast.warning("No emails found under linked label in the past 30 days.");
      else toast.success(bits.join(" · "));
      qc.invalidateQueries({ queryKey: ["folders-full"] });
      qc.invalidateQueries({ queryKey: ["folder-example-count", folder.id] });
      qc.invalidateQueries({ queryKey: ["folder-domains", folder.id] });
      qc.invalidateQueries({ queryKey: ["emails"] });
    } catch (e: any) { toast.error(e.message ?? "Failed to learn"); }
    finally { setLearning(false); }
  }

  return (
    <div>
      <div className="flex items-center gap-3">
        <input type="color" value={local.color} onChange={(e) => setLocal({ ...local, color: e.target.value })} className="h-9 w-12 cursor-pointer rounded border border-border bg-transparent" />
        <Input className="flex-1" value={local.name} onChange={(e) => setLocal({ ...local, name: e.target.value })} />
        <Input type="number" className="w-20" value={local.priority} onChange={(e) => setLocal({ ...local, priority: parseInt(e.target.value) || 0 })} title="Priority (higher wins)" />
        <Button variant="ghost" size="icon" onClick={remove}><Trash2 className="h-4 w-4 text-destructive" /></Button>
      </div>

      <div className="mt-4 grid grid-cols-[auto_1fr] items-center gap-2">
        <Label className="text-xs uppercase tracking-wider text-muted-foreground"><Link2 className="mr-1 inline h-3 w-3" />Gmail label</Label>
        <Select value={local.gmail_label_id ?? ""} onValueChange={(v) => setLocal({ ...local, gmail_label_id: v || null })}>
          <SelectTrigger><SelectValue placeholder="Not linked" /></SelectTrigger>
          <SelectContent>
            {labels.map((l) => (<SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>))}
          </SelectContent>
        </Select>
      </div>

      <div className="mt-4">
        <Label className="text-xs uppercase tracking-wider text-muted-foreground">AI rule (natural language)</Label>
        <Textarea className="mt-1.5" rows={2} placeholder='e.g. "Newsletters, marketing emails"' value={local.ai_rule ?? ""} onChange={(e) => setLocal({ ...local, ai_rule: e.target.value })} />
      </div>

      <div className="mt-4 rounded-md border border-border bg-muted/30 p-3">
        <div className="flex items-center justify-between">
          <div className="text-xs uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
            <Sparkles className="h-3 w-3" /> Learned profile
          </div>
          <Button size="sm" variant="outline" onClick={learn} disabled={learning || !folder.gmail_label_id}>
            {learning ? "Learning…" : folder.last_learned_at ? "Re-learn" : "Learn from existing emails"}
          </Button>
        </div>
        <p className="mt-2 text-sm text-foreground/80">
          {folder.learned_profile || <span className="text-muted-foreground italic">Not learned yet. {linkedLabel ? `Linked to "${linkedLabel.name}".` : "Link a Gmail label and save first."}</span>}
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          {exampleCount} example{exampleCount === 1 ? "" : "s"}
          {folder.last_learned_at && ` · learned ${new Date(folder.last_learned_at).toLocaleString()}`}
          {" · "}auto-updates as you move emails in Gmail
        </p>
        {(domainsQ.data?.length ?? 0) > 0 && (
          <div className="mt-3 border-t border-border/60 pt-3">
            <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Suggested domains</div>
            <div className="flex flex-wrap gap-1.5">
              {domainsQ.data!.map((s) => (
                <button
                  key={s.domain}
                  onClick={() => addDomain(s.domain)}
                  className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2.5 py-1 text-xs hover:border-primary hover:bg-primary/5 transition-colors"
                  title={`Click to auto-route all ${s.domain} emails to ${folder.name}`}
                >
                  <Plus className="h-3 w-3" />
                  <span className="font-mono">{s.domain}</span>
                  <span className="text-muted-foreground">· {s.count}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-4">
        <label className="flex items-center justify-between rounded-md border border-border p-3 text-sm">
          Auto-archive
          <Switch checked={local.auto_archive} onCheckedChange={(v) => setLocal({ ...local, auto_archive: v })} />
        </label>
        <label className="flex items-center justify-between rounded-md border border-border p-3 text-sm">
          Auto mark-read
          <Switch checked={local.auto_mark_read} onCheckedChange={(v) => setLocal({ ...local, auto_mark_read: v })} />
        </label>
      </div>

      <div className="mt-4">
        <Label className="text-xs uppercase tracking-wider text-muted-foreground">Filters</Label>
        <div className="mt-2 space-y-1.5">
          {filters.map((f) => (
            <div key={f.id} className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm">
              <span className="text-muted-foreground">{f.field}</span>
              <span className="text-muted-foreground">{f.op}</span>
              <span className="flex-1 font-mono text-xs">{f.value}</span>
              <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => removeFilter(f.id)}><X className="h-3 w-3" /></Button>
            </div>
          ))}
          <div className="flex items-center gap-2">
            <Select value={newF.field} onValueChange={(v) => setNewF({ ...newF, field: v })}>
              <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="from">from</SelectItem>
                <SelectItem value="to">to</SelectItem>
                <SelectItem value="subject">subject</SelectItem>
                <SelectItem value="body">body</SelectItem>
                <SelectItem value="domain">domain</SelectItem>
                <SelectItem value="has_attachment">has_attachment</SelectItem>
              </SelectContent>
            </Select>
            <Select value={newF.op} onValueChange={(v) => setNewF({ ...newF, op: v })}>
              <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="contains">contains</SelectItem>
                <SelectItem value="equals">equals</SelectItem>
                <SelectItem value="regex">regex</SelectItem>
              </SelectContent>
            </Select>
            <Input className="flex-1" placeholder="value" value={newF.value} onChange={(e) => setNewF({ ...newF, value: e.target.value })} />
            <Button size="sm" onClick={addFilter}>Add</Button>
          </div>
        </div>
      </div>

      {dirty && (
        <div className="mt-4 flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setLocal(folder)}>Cancel</Button>
          <Button size="sm" onClick={save}>Save changes</Button>
        </div>
      )}
    </div>
  );
}
