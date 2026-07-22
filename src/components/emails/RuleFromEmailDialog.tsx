// "Make rule from this email…" (rules upgrade, task 11): shows the
// AI-proposed folder + rule tree (or the deterministic fallback), lets
// the user rename/toggle actions, dry-runs it with the task-10
// simulator, and creates the folder on approval. The proposal's shape
// was already Zod-validated server-side — this dialog only ever holds
// a bounded, safe rule tree.
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Bot, Sparkles } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { proposeRuleFromEmail } from "@/lib/sync/propose-rule.functions";
import { simulateRule } from "@/lib/sync/simulate-rule.functions";
import { PROPOSABLE_ACTIONS, type ProposableAction } from "@/lib/sync/propose-rule";
import type { SimulationResult } from "@/lib/sync/simulate-rule";
import type { RuleNode } from "@/lib/sync/types";
import { createFolder } from "@/lib/gmail/folder-mgmt.functions";

const ACTION_LABELS: Record<ProposableAction, string> = {
  archive: "Skip inbox",
  mark_read: "Mark read",
  star: "Star",
};

/** Flatten a rule tree into readable "field op value" lines. */
function describeTree(node: RuleNode, depth = 0): string[] {
  if (node.type === "cond") {
    return [`${"  ".repeat(depth)}${node.field} ${node.op} "${node.value}"`];
  }
  const inner = node.children.flatMap((c) => describeTree(c, depth + 1));
  return [`${"  ".repeat(depth)}${node.op.toUpperCase()} group:`, ...inner];
}

export function RuleFromEmailDialog({
  emailId,
  open,
  onOpenChange,
}: {
  emailId: string | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const proposeFn = useServerFn(proposeRuleFromEmail);
  const simulateFn = useServerFn(simulateRule);
  const createFolderFn = useServerFn(createFolder);

  const proposalQ = useQuery({
    queryKey: ["rule-proposal", emailId],
    enabled: open && !!emailId,
    staleTime: Infinity,
    retry: false,
    queryFn: () => proposeFn({ data: { email_id: emailId! } }),
  });

  const [name, setName] = useState("");
  const [actions, setActions] = useState<Set<ProposableAction>>(new Set());
  const [sim, setSim] = useState<SimulationResult | null>(null);
  const [simBusy, setSimBusy] = useState(false);
  const [creating, setCreating] = useState(false);

  // Adopt the proposal once it lands (and reset when the target changes).
  useEffect(() => {
    if (proposalQ.data) {
      setName(proposalQ.data.suggested_folder_name);
      setActions(new Set(proposalQ.data.actions));
      setSim(null);
    }
  }, [proposalQ.data]);

  const proposal = proposalQ.data ?? null;

  async function runPreview() {
    if (!proposal) return;
    setSimBusy(true);
    try {
      const r = await simulateFn({
        data: {
          account_id: proposal.account_id,
          days: 7,
          draft: {
            name: name || proposal.suggested_folder_name,
            filter_tree: proposal.filter_tree,
          },
        },
      });
      setSim(r);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Preview failed");
    } finally {
      setSimBusy(false);
    }
  }

  async function create() {
    if (!proposal || !name.trim()) return;
    setCreating(true);
    try {
      const created = await createFolderFn({
        data: {
          account_id: proposal.account_id,
          name: name.trim(),
          gmail_label_id: null,
        },
      });
      // Same RLS-scoped follow-up the folder creation dialog uses.
      const patch: Record<string, unknown> = { filter_tree: proposal.filter_tree };
      if (actions.has("archive")) patch.auto_archive = true;
      if (actions.has("mark_read")) patch.auto_mark_read = true;
      if (actions.has("star")) patch.auto_star = true;
      const { error } = await supabase
        .from("folders")
        .update(patch as never)
        .eq("id", created.id);
      if (error) throw new Error(error.message);
      qc.invalidateQueries({ queryKey: ["folders"] });
      qc.invalidateQueries({ queryKey: ["folders-full"] });
      toast.success(`Folder "${name.trim()}" created — future matching mail will route there.`);
      onOpenChange(false);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Couldn't create the folder");
    } finally {
      setCreating(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" /> Rule from this email
          </DialogTitle>
          <DialogDescription>
            {proposal?.fallback
              ? "The AI proposal didn't validate, so this is a safe sender rule instead."
              : "AI-proposed rule — review, preview, then create. Nothing is saved until you approve."}
          </DialogDescription>
        </DialogHeader>

        {proposalQ.isLoading && (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Bot className="h-4 w-4 animate-pulse text-primary" /> Drafting a rule…
          </div>
        )}
        {proposalQ.isError && (
          <p className="py-4 text-sm text-destructive">
            {(proposalQ.error as Error)?.message ?? "Couldn't draft a rule."}
          </p>
        )}

        {proposal && (
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Folder name
              </label>
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Rule</label>
              <pre className="whitespace-pre-wrap rounded-md border border-border bg-card/40 px-3 py-2 font-mono text-xs text-foreground/90">
                {describeTree(proposal.filter_tree).join("\n")}
              </pre>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {PROPOSABLE_ACTIONS.map((a) => (
                <button
                  key={a}
                  type="button"
                  aria-pressed={actions.has(a)}
                  onClick={() =>
                    setActions((prev) => {
                      const next = new Set(prev);
                      if (next.has(a)) next.delete(a);
                      else next.add(a);
                      return next;
                    })
                  }
                  className={`rounded-sm border px-2.5 py-1 text-xs transition-colors ${
                    actions.has(a)
                      ? "border-primary text-primary"
                      : "border-border text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {ACTION_LABELS[a]}
                </button>
              ))}
            </div>
            <div className="rounded-md border border-border bg-card/30 px-3 py-2 text-xs">
              {sim ? (
                <span>
                  Last 7 days: <strong>{sim.moves}</strong> would move here ·{" "}
                  {sim.excluded > 0 ? `${sim.excluded} vetoed · ` : ""}
                  {sim.no_change} untouched of {sim.scanned} scanned.
                </span>
              ) : (
                <button
                  type="button"
                  onClick={runPreview}
                  disabled={simBusy}
                  className="text-primary hover:underline disabled:opacity-60"
                >
                  {simBusy ? "Simulating…" : "Preview against last 7 days →"}
                </button>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={create} disabled={!proposal || !name.trim() || creating}>
            {creating ? "Creating…" : "Create folder & rule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
