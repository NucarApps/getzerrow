import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, Info, Layers, Loader2, Plus, ShieldCheck, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RuleChangeSetDialog } from "@/components/rules/RuleChangeSetDialog";
import {
  conditionSentence,
  draftLevel,
  FIELD_OPTIONS,
  isBooleanField,
  levelLabel,
  OP_OPTIONS,
  parseConditionInput,
} from "@/components/rules/rule-sentence";
import { previewRuleChange } from "@/lib/rules/planner.functions";
import type { Condition } from "@/lib/rules/types";

const PREVIEW_DEBOUNCE_MS = 600;

const emptyCondition = (): Condition => ({ field: "from", op: "contains", value: "" });

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

/** Sentence-style rule editor with a live preview.
 *
 * A rule reads as one sentence, values are chips, and the OR-of-ANDs shape
 * stays hidden until a second match group is added. Every keystroke settles
 * into a debounced preview: how many recent messages the rule matches, five
 * samples, the ladder level, and any collision with an existing rule. A
 * blocking collision disables saving. */
export function RuleSentenceEditor({
  accountId,
  folderId,
  folderName,
  ruleId,
  initialGroups,
  onSave,
  onCancel,
}: {
  accountId: string;
  folderId: string;
  folderName: string;
  ruleId?: string | null;
  initialGroups?: Condition[][];
  onSave: (groups: Condition[][]) => void | Promise<void>;
  onCancel?: () => void;
}) {
  const [groups, setGroups] = useState<Condition[][]>(
    initialGroups?.length ? initialGroups : [[emptyCondition()]],
  );
  const [draft, setDraft] = useState("");
  const [changeSetOpen, setChangeSetOpen] = useState(false);

  const complete = useMemo(
    () =>
      groups
        .map((g) => g.filter((c) => isBooleanField(c.field) || c.value.trim().length > 0))
        .filter((g) => g.length > 0),
    [groups],
  );
  const level = draftLevel(complete.length ? complete : [[emptyCondition()]]);
  const debouncedGroups = useDebounced(complete, PREVIEW_DEBOUNCE_MS);

  const previewFn = useServerFn(previewRuleChange);
  const preview = useQuery({
    queryKey: ["rule-preview", accountId, folderId, ruleId ?? null, debouncedGroups],
    queryFn: () =>
      previewFn({
        data: {
          account_id: accountId,
          folder_id: folderId,
          rule_id: ruleId ?? null,
          replaces_rule_ids: [],
          groups: debouncedGroups,
          days: 90,
        },
      }),
    enabled: debouncedGroups.length > 0,
    staleTime: 30_000,
  });

  const blocked = preview.data?.conflicts.blocked === true;

  const setCondition = (gi: number, ci: number, next: Partial<Condition>) =>
    setGroups((cur) =>
      cur.map((g, i) => (i === gi ? g.map((c, j) => (j === ci ? { ...c, ...next } : c)) : g)),
    );
  const removeCondition = (gi: number, ci: number) =>
    setGroups(
      (cur) =>
        cur
          .map((g, i) => (i === gi ? g.filter((_, j) => j !== ci) : g))
          .filter((g) => g.length > 0) || [[emptyCondition()]],
    );
  const addCondition = (gi: number, condition = emptyCondition()) =>
    setGroups((cur) => cur.map((g, i) => (i === gi ? [...g, condition] : g)));

  const commitDraft = (gi: number) => {
    const text = draft.trim();
    if (!text) return;
    addCondition(gi, parseConditionInput(text));
    setDraft("");
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-card/40 p-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">
            File mail into <span className="font-medium text-foreground">{folderName}</span> when
          </p>
          <Badge variant="secondary" className="shrink-0 font-normal">
            {levelLabel(level)}
          </Badge>
        </div>

        <div className="space-y-3">
          {groups.map((group, gi) => (
            <div key={gi} className="space-y-2">
              {gi > 0 && (
                <div className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted-foreground">
                  <Layers className="h-3.5 w-3.5" /> or when
                </div>
              )}
              {group.map((c, ci) => (
                <div key={ci} className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <Select value={c.field} onValueChange={(v) => setCondition(gi, ci, { field: v })}>
                    <SelectTrigger className="h-8 w-full text-xs sm:w-64">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FIELD_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {isBooleanField(c.field) ? (
                    <Select
                      value={(c.value || "true").toLowerCase() === "false" ? "false" : "true"}
                      onValueChange={(v) => setCondition(gi, ci, { op: "equals", value: v })}
                    >
                      <SelectTrigger className="h-8 w-full text-xs sm:w-28">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="true">is yes</SelectItem>
                        <SelectItem value="false">is no</SelectItem>
                      </SelectContent>
                    </Select>
                  ) : (
                    <>
                      <Select value={c.op} onValueChange={(v) => setCondition(gi, ci, { op: v })}>
                        <SelectTrigger className="h-8 w-full text-xs sm:w-40">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {OP_OPTIONS.map((o) => (
                            <SelectItem key={o.value} value={o.value}>
                              {o.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Input
                        value={c.value}
                        onChange={(e) => setCondition(gi, ci, { value: e.target.value })}
                        placeholder="billing@netflix.com"
                        className="h-8 flex-1 text-xs"
                      />
                    </>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0"
                    onClick={() => removeCondition(gi, ci)}
                    aria-label="Remove condition"
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}

              <div className="flex flex-wrap items-center gap-2">
                <Input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commitDraft(gi);
                    }
                  }}
                  onBlur={() => commitDraft(gi)}
                  placeholder="Type an address, a domain or a phrase and press Enter"
                  className="h-8 flex-1 text-xs"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8"
                  onClick={() => addCondition(gi)}
                >
                  <Plus className="mr-1 h-3.5 w-3.5" /> and
                </Button>
              </div>
            </div>
          ))}
        </div>

        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-2 h-8 text-xs"
          onClick={() => setGroups((cur) => [...cur, [emptyCondition()]])}
        >
          <Plus className="mr-1 h-3.5 w-3.5" /> Add another way to match
        </Button>
      </div>

      {/* Live preview */}
      <div className="space-y-3">
        {preview.isFetching && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking recent mail…
          </p>
        )}

        {preview.data && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">
                Matches {preview.data.conflicts.candidate_match_count} of {preview.data.scanned}{" "}
                recent messages
              </span>
              {preview.data.change_set.move_count > 0 && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setChangeSetOpen(true)}
                >
                  {preview.data.headline}
                </Button>
              )}
            </div>

            {preview.data.conflicts.candidate_samples.length > 0 && (
              <ul className="space-y-1">
                {preview.data.conflicts.candidate_samples.map((s) => (
                  <li
                    key={s.id}
                    className="truncate rounded border border-border bg-background/40 px-2 py-1 text-xs"
                  >
                    <span className="text-muted-foreground">{s.from_addr}</span> — {s.subject}
                  </li>
                ))}
              </ul>
            )}

            {preview.data.conflicts.conflicts.map((c) => (
              <div
                key={c.rule_id}
                className={`flex items-start gap-2 rounded-md border p-2 text-xs ${
                  c.kind === "block"
                    ? "border-destructive/50 bg-destructive/10 text-foreground"
                    : "border-border bg-muted/40 text-muted-foreground"
                }`}
              >
                {c.kind === "block" ? (
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                ) : c.kind === "merge" ? (
                  <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                ) : (
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                )}
                <div className="min-w-0">
                  <p>{c.message}</p>
                  {c.samples.length > 0 && (
                    <p className="mt-1 truncate opacity-80">
                      e.g. {c.samples[0]!.from_addr} — {c.samples[0]!.subject}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </>
        )}

        {preview.isError && (
          <p className="text-xs text-destructive">
            Couldn't check this rule against recent mail. You can still save it.
          </p>
        )}
      </div>

      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {complete.length > 0
            ? complete.map((g) => g.map(conditionSentence).join(" and ")).join(" — or — ")
            : "Add a condition to get started."}
        </p>
        <div className="flex gap-2">
          {onCancel && (
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button
            type="button"
            disabled={complete.length === 0 || blocked}
            onClick={() => onSave(complete)}
            title={blocked ? "Resolve the conflict above before saving" : undefined}
          >
            Save rule
          </Button>
        </div>
      </div>

      {preview.data && (
        <RuleChangeSetDialog
          open={changeSetOpen}
          onOpenChange={setChangeSetOpen}
          changeSet={preview.data.change_set}
          onApplied={() => preview.refetch()}
        />
      )}
    </div>
  );
}
