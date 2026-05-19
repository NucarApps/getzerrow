import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { createGmailLabel, listGmailLabels, learnFolderFromLabel } from "@/lib/gmail.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card } from "@/components/ui/card";
import { Plus, Trash2, X, Sparkles, Link2 } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/folders")({ component: FoldersPage });

type Folder = {
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
};
type Filter = { id: string; folder_id: string; field: string; op: string; value: string };
type GLabel = { id: string; name: string; type: string };

const NEW_LABEL = "__new__";

function FoldersPage() {
  const qc = useQueryClient();
  const createLabel = useServerFn(createGmailLabel);
  const listLabelsFn = useServerFn(listGmailLabels);
  const [newName, setNewName] = useState("");
  const [newLabelChoice, setNewLabelChoice] = useState<string>(NEW_LABEL);

  const foldersQ = useQuery({
    queryKey: ["folders-full"],
    queryFn: async () => {
      const { data } = await supabase.from("folders").select("*").order("priority", { ascending: false });
      return (data ?? []) as Folder[];
    },
  });
  const filtersQ = useQuery({
    queryKey: ["folder-filters"],
    queryFn: async () => {
      const { data } = await supabase.from("folder_filters").select("*");
      return (data ?? []) as Filter[];
    },
  });
  const labelsQ = useQuery({
    queryKey: ["gmail-labels"],
    queryFn: async () => {
      try { return (await listLabelsFn()).labels as GLabel[]; } catch { return [] as GLabel[]; }
    },
  });
  const exampleCountsQ = useQuery({
    queryKey: ["folder-example-counts"],
    queryFn: async () => {
      const { data } = await supabase.from("folder_examples").select("folder_id");
      const counts: Record<string, number> = {};
      for (const r of data ?? []) counts[r.folder_id] = (counts[r.folder_id] ?? 0) + 1;
      return counts;
    },
  });

  async function addFolder() {
    if (!newName.trim()) return;
    const userId = (await supabase.auth.getUser()).data.user!.id;
    let labelId: string | null = null;
    if (newLabelChoice === NEW_LABEL) {
      try {
        const r = await createLabel({ data: { name: newName.trim() } });
        labelId = r.id;
      } catch {
        toast.warning("Couldn't create Gmail label (Gmail may not be connected). Folder created locally.");
      }
    } else {
      labelId = newLabelChoice;
    }
    const { error } = await supabase.from("folders").insert({
      name: newName.trim(),
      user_id: userId,
      gmail_label_id: labelId,
      color: pickColor(),
    });
    if (error) { toast.error(error.message); return; }
    setNewName("");
    setNewLabelChoice(NEW_LABEL);
    qc.invalidateQueries({ queryKey: ["folders-full"] });
    qc.invalidateQueries({ queryKey: ["folders"] });
  }

  return (
    <div className="h-screen overflow-y-auto p-8">
      <div className="mx-auto max-w-3xl">
        <h1 className="font-display text-4xl">Folders</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Link a folder to an existing Gmail label, then let Zerrow learn from what's already in it. Manual moves in Gmail keep training the AI.
        </p>

        <Card className="mt-6 p-4">
          <div className="flex items-center gap-3">
            <Input placeholder="New folder name (e.g. Newsletters)" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addFolder()} />
            <Select value={newLabelChoice} onValueChange={setNewLabelChoice}>
              <SelectTrigger className="w-64"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NEW_LABEL}>Create new Gmail label</SelectItem>
                {(labelsQ.data ?? []).map((l) => (
                  <SelectItem key={l.id} value={l.id}>Link to: {l.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button onClick={addFolder}><Plus className="mr-1.5 h-4 w-4" />Add</Button>
          </div>
        </Card>

        <div className="mt-6 space-y-4">
          {(foldersQ.data ?? []).map((f) => (
            <FolderEditor
              key={f.id}
              folder={f}
              filters={(filtersQ.data ?? []).filter((x) => x.folder_id === f.id)}
              labels={labelsQ.data ?? []}
              exampleCount={exampleCountsQ.data?.[f.id] ?? 0}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function FolderEditor({ folder, filters, labels, exampleCount }: { folder: Folder; filters: Filter[]; labels: GLabel[]; exampleCount: number }) {
  const qc = useQueryClient();
  const learnFn = useServerFn(learnFolderFromLabel);
  const [local, setLocal] = useState(folder);
  const [newF, setNewF] = useState({ field: "from", op: "contains", value: "" });
  const [learning, setLearning] = useState(false);
  const dirty = JSON.stringify(local) !== JSON.stringify(folder);

  const linkedLabel = labels.find((l) => l.id === folder.gmail_label_id);

  async function save() {
    const { error } = await supabase.from("folders").update({
      name: local.name, color: local.color, ai_rule: local.ai_rule,
      gmail_label_id: local.gmail_label_id,
      auto_archive: local.auto_archive, auto_mark_read: local.auto_mark_read, priority: local.priority,
    }).eq("id", folder.id);
    if (error) { toast.error(error.message); return; }
    toast.success("Saved");
    qc.invalidateQueries({ queryKey: ["folders-full"] });
    qc.invalidateQueries({ queryKey: ["folders"] });
  }

  async function remove() {
    if (!confirm(`Delete "${folder.name}"? Emails in it will move to Unsorted.`)) return;
    await supabase.from("folders").delete().eq("id", folder.id);
    qc.invalidateQueries({ queryKey: ["folders-full"] });
    qc.invalidateQueries({ queryKey: ["folders"] });
  }

  async function addFilter() {
    if (!newF.value.trim()) return;
    await supabase.from("folder_filters").insert({ ...newF, folder_id: folder.id, value: newF.value.trim() });
    setNewF({ field: "from", op: "contains", value: "" });
    qc.invalidateQueries({ queryKey: ["folder-filters"] });
  }
  async function removeFilter(id: string) {
    await supabase.from("folder_filters").delete().eq("id", id);
    qc.invalidateQueries({ queryKey: ["folder-filters"] });
  }

  async function learn() {
    if (!folder.gmail_label_id) { toast.error("Link a Gmail label first, then save."); return; }
    setLearning(true);
    try {
      const r = await learnFn({ data: { folder_id: folder.id } });
      if (r.learned === 0) toast.warning("No emails found under linked label — make sure the label has messages.");
      else toast.success(`Learned from ${r.learned} emails`);
      qc.invalidateQueries({ queryKey: ["folders-full"] });
      qc.invalidateQueries({ queryKey: ["folder-example-counts"] });
    } catch (e: any) {
      toast.error(e.message ?? "Failed to learn");
    } finally {
      setLearning(false);
    }
  }

  return (
    <Card className="p-5">
      <div className="flex items-center gap-3">
        <input
          type="color" value={local.color}
          onChange={(e) => setLocal({ ...local, color: e.target.value })}
          className="h-9 w-12 cursor-pointer rounded border border-border bg-transparent"
        />
        <Input className="flex-1" value={local.name} onChange={(e) => setLocal({ ...local, name: e.target.value })} />
        <Input type="number" className="w-20" value={local.priority} onChange={(e) => setLocal({ ...local, priority: parseInt(e.target.value) || 0 })} title="Priority (higher wins)" />
        <Button variant="ghost" size="icon" onClick={remove}><Trash2 className="h-4 w-4 text-destructive" /></Button>
      </div>

      <div className="mt-4 grid grid-cols-[auto_1fr] items-center gap-2">
        <Label className="text-xs uppercase tracking-wider text-muted-foreground"><Link2 className="mr-1 inline h-3 w-3" />Gmail label</Label>
        <Select value={local.gmail_label_id ?? ""} onValueChange={(v) => setLocal({ ...local, gmail_label_id: v || null })}>
          <SelectTrigger><SelectValue placeholder="Not linked" /></SelectTrigger>
          <SelectContent>
            {labels.map((l) => (
              <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="mt-4">
        <Label className="text-xs uppercase tracking-wider text-muted-foreground">AI rule (natural language)</Label>
        <Textarea
          className="mt-1.5"
          rows={2}
          placeholder='e.g. "Newsletters, marketing emails, product updates"'
          value={local.ai_rule ?? ""}
          onChange={(e) => setLocal({ ...local, ai_rule: e.target.value })}
        />
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
    </Card>
  );
}

const palette = ["#f59e0b", "#10b981", "#3b82f6", "#ec4899", "#8b5cf6", "#ef4444", "#14b8a6", "#eab308"];
function pickColor() { return palette[Math.floor(Math.random() * palette.length)]; }
