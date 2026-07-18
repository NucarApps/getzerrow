// Editor for a single label's auto-assignment rules. Renders inside the
// EditGroupDialog so users can say "anyone with this domain / linked to
// this company / classified as this AI category joins this label".
//
// Rules can be auto-apply (contact is added silently on save) or
// suggest-only (a chip appears on the contact for one-click accept).
//
// Reads/writes go through the server functions in
// `src/lib/contacts/group-rules.functions.ts`; there's no client-side
// business logic here.

import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Trash2 } from "lucide-react";
import {
  addGroupRule,
  deleteGroupRule,
  listGroupRules,
  updateGroupRule,
} from "@/lib/contacts/group-rules.functions";
import { AI_CATEGORIES } from "@/lib/contacts/group-rules";

type RuleType = "domain" | "company_id" | "ai_category";

export function GroupRulesSection({ groupId }: { groupId: string }) {
  const qc = useQueryClient();
  const list = useServerFn(listGroupRules);
  const add = useServerFn(addGroupRule);
  const upd = useServerFn(updateGroupRule);
  const del = useServerFn(deleteGroupRule);

  const q = useQuery({
    queryKey: ["group-rules", groupId],
    queryFn: () => list({ data: { groupId } }),
  });

  const [ruleType, setRuleType] = useState<RuleType>("domain");
  const [value, setValue] = useState("");
  const [autoApply, setAutoApply] = useState(true);

  useEffect(() => {
    // Reset value when switching rule type; keep sensible default per kind.
    setValue("");
    if (ruleType === "ai_category") setValue(AI_CATEGORIES[0]);
  }, [ruleType]);

  const addMut = useMutation({
    mutationFn: () => add({ data: { groupId, ruleType, value, autoApply } }),
    onSuccess: () => {
      setValue(ruleType === "ai_category" ? AI_CATEGORIES[0] : "");
      qc.invalidateQueries({ queryKey: ["group-rules", groupId] });
      toast.success("Rule added");
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const delMut = useMutation({
    mutationFn: (id: string) => del({ data: { id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["group-rules", groupId] }),
  });

  const toggleMut = useMutation({
    mutationFn: (v: { id: string; autoApply: boolean }) =>
      upd({ data: { id: v.id, autoApply: v.autoApply } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["group-rules", groupId] }),
  });

  const rules = q.data?.rules ?? [];

  return (
    <div className="rounded-md border border-border/60 p-3">
      <div className="mb-2">
        <Label className="text-sm">Auto-assign rules</Label>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          New contacts that match a rule join this label automatically.
          Turn a rule off "auto" to only suggest it.
        </p>
      </div>

      {rules.length > 0 && (
        <ul className="mb-3 space-y-1.5">
          {rules.map((r) => (
            <li
              key={r.id}
              className="flex items-center gap-2 rounded-md border border-border/40 bg-muted/30 px-2 py-1.5 text-sm"
            >
              <Badge variant="secondary" className="text-[10px] uppercase">
                {r.rule_type === "company_id"
                  ? "company"
                  : r.rule_type === "ai_category"
                    ? "AI category"
                    : "domain"}
              </Badge>
              <span className="min-w-0 flex-1 truncate">{r.value}</span>
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-muted-foreground">Auto</span>
                <Switch
                  checked={r.auto_apply}
                  onCheckedChange={(v) =>
                    toggleMut.mutate({ id: r.id, autoApply: v })
                  }
                />
              </div>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 text-destructive"
                onClick={() => delMut.mutate(r.id)}
                aria-label="Delete rule"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <div>
          <Label className="text-[11px] text-muted-foreground">Type</Label>
          <select
            value={ruleType}
            onChange={(e) => setRuleType(e.target.value as RuleType)}
            className="mt-1 h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="domain">Email domain</option>
            <option value="ai_category">AI category</option>
          </select>
        </div>
        <div className="min-w-[10rem] flex-1">
          <Label className="text-[11px] text-muted-foreground">Value</Label>
          {ruleType === "ai_category" ? (
            <select
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            >
              {AI_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          ) : (
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="nissanusa.com"
              className="mt-1 h-9"
            />
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <Label className="text-[11px] text-muted-foreground">Auto</Label>
          <Switch checked={autoApply} onCheckedChange={setAutoApply} />
        </div>
        <Button
          size="sm"
          onClick={() => addMut.mutate()}
          disabled={!value.trim() || addMut.isPending}
        >
          Add rule
        </Button>
      </div>
    </div>
  );
}
