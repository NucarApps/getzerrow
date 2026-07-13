// Folder-scoped AI chat. The user describes what they want; the AI proposes
// concrete changes to THIS folder's settings, rules, and filters. Nothing is
// written until the user reviews each change and approves it.
import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Sparkles, Send, Check, X, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  proposeFolderChanges,
  applyFolderChanges,
  getFolderChatHistory,
  discardFolderChanges,
} from "@/lib/folder-chat.functions";
import type { Folder } from "./FolderEditor";

type SettingsPatch = {
  name?: string;
  color?: string;
  priority?: number;
  auto_archive?: boolean;
  auto_mark_read?: boolean;
  auto_star?: boolean;
  hide_from_inbox?: boolean;
  skip_ai?: boolean;
  overrides_inbox_override?: boolean;
  is_cold_email?: boolean;
  forward_to?: string | null;
  snooze_hours?: number;
  min_ai_confidence?: number;
  filter_logic?: "any" | "all";
};

type Action =
  | {
      type: "add_filter";
      field: "from" | "domain" | "subject";
      op: "contains" | "equals" | "starts_with" | "not_contains" | "not_equals" | "domain_in";
      value: string;
      why: string;
    }
  | { type: "remove_filter"; filter_id: string; why: string }
  | { type: "update_folder_rule"; ai_rule: string; why: string }
  | { type: "update_folder_profile"; learned_profile: string; why: string }
  | { type: "update_folder_settings"; settings: SettingsPatch; why: string };

type Proposal = {
  reply: string;
  clarifying_question: string;
  actions: Action[];
};

type ChatTurn =
  | { kind: "user"; content: string }
  | {
      kind: "assistant";
      content: string;
      clarifyingQuestion: string;
      actions: Action[];
      selected: boolean[];
      applied: boolean;
      appliedAt?: string;
      messageId?: string;
    };

const BOOL_LABELS: Record<string, string> = {
  auto_archive: "auto-archive",
  auto_mark_read: "auto mark-read",
  auto_star: "auto-star",
  hide_from_inbox: "hide from inbox",
  skip_ai: "rules only",
  overrides_inbox_override: 'beat "always send to inbox"',
  is_cold_email: "cold-email folder",
};

function describeSettings(s: SettingsPatch): string[] {
  const parts: string[] = [];
  if (s.name !== undefined) parts.push(`Rename to "${s.name}"`);
  if (s.color !== undefined) parts.push(`Set color to ${s.color}`);
  if (s.priority !== undefined) parts.push(`Set priority to ${s.priority}`);
  for (const key of Object.keys(BOOL_LABELS)) {
    const v = (s as Record<string, unknown>)[key];
    if (typeof v === "boolean") parts.push(`${v ? "Turn on" : "Turn off"} ${BOOL_LABELS[key]}`);
  }
  if (s.forward_to !== undefined)
    parts.push(s.forward_to ? `Auto-forward to ${s.forward_to}` : "Stop auto-forwarding");
  if (s.snooze_hours !== undefined)
    parts.push(s.snooze_hours > 0 ? `Snooze on arrival for ${s.snooze_hours}h` : "Turn off snooze");
  if (s.min_ai_confidence !== undefined)
    parts.push(`Set min AI confidence to ${Math.round(s.min_ai_confidence * 100)}%`);
  if (s.filter_logic !== undefined) parts.push(`Match ${s.filter_logic} filters`);
  return parts;
}

function describeAction(action: Action): string {
  if (action.type === "add_filter") {
    if (action.op === "domain_in") {
      return `Add allowlist: only mail from ${action.value
        .split(/[\s,;]+/)
        .filter(Boolean)
        .join(", ")}`;
    }
    const opLabel =
      action.op === "not_contains"
        ? "does not contain"
        : action.op === "not_equals"
          ? "does not equal"
          : action.op.replace("_", " ");
    return `Add filter: ${action.field} ${opLabel} "${action.value}"`;
  }
  if (action.type === "remove_filter") {
    return "Remove a filter";
  }
  if (action.type === "update_folder_rule") {
    return `Update AI rule: "${action.ai_rule}"`;
  }
  if (action.type === "update_folder_profile") {
    return "Refine the learned profile";
  }
  const parts = describeSettings(action.settings);
  return parts.length ? parts.join(" · ") : "Update folder settings";
}

// Reduce an approved settings action into a patch we can lift into the editor.
function settingsToLocalPatch(actions: Action[]): Partial<Folder> {
  const patch: Partial<Folder> = {};
  for (const a of actions) {
    if (a.type === "update_folder_rule") patch.ai_rule = a.ai_rule.trim();
    else if (a.type === "update_folder_profile") patch.learned_profile = a.learned_profile.trim();
    else if (a.type === "update_folder_settings") {
      const s = a.settings;
      if (s.name !== undefined) patch.name = s.name.trim();
      if (s.color !== undefined) patch.color = s.color;
      if (s.priority !== undefined) patch.priority = s.priority;
      if (s.auto_archive !== undefined) patch.auto_archive = s.auto_archive;
      if (s.auto_mark_read !== undefined) patch.auto_mark_read = s.auto_mark_read;
      if (s.auto_star !== undefined) patch.auto_star = s.auto_star;
      if (s.hide_from_inbox !== undefined) patch.hide_from_inbox = s.hide_from_inbox;
      if (s.skip_ai !== undefined) patch.skip_ai = s.skip_ai;
      if (s.overrides_inbox_override !== undefined)
        patch.overrides_inbox_override = s.overrides_inbox_override;
      if (s.is_cold_email !== undefined) patch.is_cold_email = s.is_cold_email;
      if (s.forward_to !== undefined) patch.forward_to = s.forward_to;
      if (s.snooze_hours !== undefined) patch.snooze_hours = s.snooze_hours;
      if (s.min_ai_confidence !== undefined) patch.min_ai_confidence = s.min_ai_confidence;
      if (s.filter_logic !== undefined) patch.filter_logic = s.filter_logic;
    }
  }
  return patch;
}

export function FolderChatPanel({
  folder,
  onApplied,
}: {
  folder: Folder;
  onApplied?: (patch: Partial<Folder>) => void;
}) {
  const qc = useQueryClient();
  const proposeFn = useServerFn(proposeFolderChanges);
  const applyFn = useServerFn(applyFolderChanges);
  const getHistoryFn = useServerFn(getFolderChatHistory);

  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [hydrating, setHydrating] = useState(true);
  const [applyingIndex, setApplyingIndex] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, busy]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Rehydrate the persisted conversation for this folder on mount / folder change.
  useEffect(() => {
    let cancelled = false;
    setHydrating(true);
    setTurns([]);
    (async () => {
      try {
        const res = (await getHistoryFn({ data: { folder_id: folder.id } })) as {
          messages: Array<{
            id: string;
            role: "user" | "assistant";
            content: string;
            actions: Action[] | null;
            applied_action_indexes: number[];
          }>;
        };
        if (cancelled) return;
        const restored: ChatTurn[] = res.messages.map((m) => {
          if (m.role === "user") return { kind: "user", content: m.content };
          const actions = m.actions ?? [];
          const appliedSet = new Set(m.applied_action_indexes ?? []);
          const wasApplied = actions.length === 0 || appliedSet.size > 0;
          return {
            kind: "assistant",
            content: m.content,
            clarifyingQuestion: "",
            actions,
            selected: actions.map((_, i) => !appliedSet.has(i)),
            applied: wasApplied,
            appliedAt: appliedSet.size > 0 ? "restored" : undefined,
            messageId: m.id,
          };
        });
        setTurns(restored);
      } catch {
        if (!cancelled) setTurns([]);
      } finally {
        if (!cancelled) setHydrating(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [folder.id, getHistoryFn]);

  const send = async () => {
    const msg = input.trim();
    if (!msg || busy) return;
    setInput("");
    setBusy(true);
    setTurns((prev) => [...prev, { kind: "user", content: msg }]);
    try {
      const proposal = (await proposeFn({
        data: { folder_id: folder.id, user_message: msg },
      })) as Proposal & { message_id: string | null };
      setTurns((prev) => [
        ...prev,
        {
          kind: "assistant",
          content: proposal.reply,
          clarifyingQuestion: proposal.clarifying_question,
          actions: proposal.actions,
          selected: proposal.actions.map(() => true),
          applied: false,
          messageId: proposal.message_id ?? undefined,
        },
      ]);
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : "Couldn't reach the AI";
      toast.error(m);
      setTurns((prev) => [
        ...prev,
        {
          kind: "assistant",
          content: "",
          clarifyingQuestion: m,
          actions: [],
          selected: [],
          applied: false,
        },
      ]);
    } finally {
      setBusy(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  };

  const applyTurn = async (turnIndex: number) => {
    const turn = turns[turnIndex];
    if (!turn || turn.kind !== "assistant" || applyingIndex !== null) return;
    const appliedIndexes = turn.actions.map((_, i) => i).filter((i) => turn.selected[i]);
    const chosen = appliedIndexes.map((i) => turn.actions[i]);
    if (chosen.length === 0) {
      toast.message("Nothing selected to apply.");
      return;
    }
    setApplyingIndex(turnIndex);
    try {
      const res = (await applyFn({
        data: {
          folder_id: folder.id,
          actions: chosen,
          message_id: turn.messageId,
          applied_indexes: appliedIndexes,
        },
      })) as {
        results: Array<{ ok: boolean; error?: string }>;
      };
      const okCount = res.results.filter((r) => r.ok).length;
      const failed = res.results.length - okCount;
      if (okCount > 0) toast.success(`Applied ${okCount} change${okCount === 1 ? "" : "s"}`);
      if (failed > 0) toast.error(`${failed} change${failed === 1 ? "" : "s"} failed`);
      setTurns((prev) =>
        prev.map((t, i) =>
          i === turnIndex && t.kind === "assistant"
            ? { ...t, applied: true, appliedAt: new Date().toISOString() }
            : t,
        ),
      );
      // Lift applied settings/rule changes back into the editor state.
      onApplied?.(settingsToLocalPatch(chosen));
      qc.invalidateQueries({ queryKey: ["folders"] });
      qc.invalidateQueries({ queryKey: ["folders-full"] });
      qc.invalidateQueries({ queryKey: ["folder-filters", folder.id] });
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : "Couldn't apply changes";
      toast.error(m);
    } finally {
      setApplyingIndex(null);
    }
  };

  const discardTurn = (turnIndex: number) => {
    setTurns((prev) =>
      prev.map((t, i) =>
        i === turnIndex && t.kind === "assistant"
          ? { ...t, actions: [], selected: [], applied: true }
          : t,
      ),
    );
  };

  return (
    <div className="flex h-[28rem] flex-col overflow-hidden rounded-md border border-border">
      <ScrollArea className="min-h-0 flex-1">
        <div ref={scrollRef} className="space-y-4 px-3 py-4">
          {hydrating && (
            <div className="flex items-center gap-2 px-1 py-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading conversation…
            </div>
          )}

          {!hydrating && turns.length === 0 && (
            <div className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-4 text-xs text-muted-foreground">
              Describe what you want to change in this folder. I'll suggest changes — nothing is
              saved until you approve. I remember our past chats, what we've applied, and this
              folder's current rules and emails.
              <ul className="mt-2 list-disc space-y-1 pl-4">
                <li>"Auto-archive everything here and hide it from my inbox."</li>
                <li>"Rename this to Receipts and make the color green."</li>
                <li>"Forward each new email to billing@acme.com and snooze for 24 hours."</li>
                <li>"Tighten the rule so human replies don't land here."</li>
              </ul>
            </div>
          )}

          {turns.map((turn, i) => {
            if (turn.kind === "user") {
              return (
                <div key={i} className="flex justify-end">
                  <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-primary px-3 py-2 text-sm text-primary-foreground">
                    {turn.content}
                  </div>
                </div>
              );
            }
            return (
              <div key={i} className="flex flex-col gap-2">
                {(turn.content || turn.clarifyingQuestion) && (
                  <div className="max-w-[85%] rounded-2xl rounded-tl-sm bg-muted px-3 py-2 text-sm text-foreground">
                    {turn.content && <p>{turn.content}</p>}
                    {turn.clarifyingQuestion && (
                      <p className={turn.content ? "mt-1 text-muted-foreground" : ""}>
                        {turn.clarifyingQuestion}
                      </p>
                    )}
                  </div>
                )}

                {turn.actions.length > 0 && (
                  <div className="rounded-lg border border-border bg-card p-3 shadow-sm">
                    <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      Proposed changes
                    </div>
                    <ul className="space-y-2">
                      {turn.actions.map((action, ai) => (
                        <li key={ai} className="flex items-start gap-2">
                          <Checkbox
                            id={`fturn-${i}-action-${ai}`}
                            checked={turn.selected[ai]}
                            disabled={turn.applied}
                            onCheckedChange={(v) =>
                              setTurns((prev) =>
                                prev.map((t, ti) =>
                                  ti === i && t.kind === "assistant"
                                    ? {
                                        ...t,
                                        selected: t.selected.map((sel, si) =>
                                          si === ai ? v === true : sel,
                                        ),
                                      }
                                    : t,
                                ),
                              )
                            }
                            className="mt-0.5"
                          />
                          <label
                            htmlFor={`fturn-${i}-action-${ai}`}
                            className="flex-1 cursor-pointer text-xs leading-snug"
                          >
                            <div className="font-medium text-foreground">
                              {describeAction(action)}
                            </div>
                            {action.why && (
                              <div className="mt-0.5 text-muted-foreground">{action.why}</div>
                            )}
                          </label>
                        </li>
                      ))}
                    </ul>

                    {!turn.applied ? (
                      <div className="mt-3 flex items-center justify-end gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7"
                          onClick={() => discardTurn(i)}
                          disabled={applyingIndex !== null}
                        >
                          <X className="mr-1 h-3.5 w-3.5" />
                          Discard
                        </Button>
                        <Button
                          size="sm"
                          className="h-7"
                          onClick={() => applyTurn(i)}
                          disabled={applyingIndex !== null}
                        >
                          {applyingIndex === i ? (
                            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Check className="mr-1 h-3.5 w-3.5" />
                          )}
                          Apply selected
                        </Button>
                      </div>
                    ) : (
                      <div className="mt-3 text-[10px] uppercase tracking-wider text-muted-foreground">
                        {turn.appliedAt ? "Applied" : "Dismissed"}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {busy && (
            <div className="flex justify-start">
              <div className="rounded-2xl rounded-tl-sm bg-muted px-3 py-2 text-sm text-muted-foreground">
                <Loader2 className="inline h-3.5 w-3.5 animate-spin" /> Thinking…
              </div>
            </div>
          )}
        </div>
      </ScrollArea>

      <div className="shrink-0 border-t border-border p-3">
        <div className="flex items-end gap-2">
          <Textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder="Tell the assistant what to change in this folder…"
            disabled={busy}
            className="min-h-[44px] max-h-32 resize-none text-sm"
            rows={2}
          />
          <Button size="icon" onClick={() => void send()} disabled={!input.trim() || busy}>
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
