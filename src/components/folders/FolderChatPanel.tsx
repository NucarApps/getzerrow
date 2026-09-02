// Folder-scoped AI chat. The user describes what they want; the AI proposes
// concrete changes to THIS folder's settings, rules, and filters. Nothing is
// written until the user reviews each change and approves it.
import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Send, Check, X } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
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
import {
  describeAction,
  settingsToLocalPatch,
  type FolderChatAction as Action,
} from "@/lib/ui/folder-chat-actions";

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
  const discardFn = useServerFn(discardFolderChanges);

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
            discarded: boolean;
          }>;
        };
        if (cancelled) return;
        const restored: ChatTurn[] = res.messages.map((m) => {
          if (m.role === "user") return { kind: "user", content: m.content };
          const actions = m.actions ?? [];
          const appliedSet = new Set(m.applied_action_indexes ?? []);
          // A discarded turn is resolved: never re-offer its actions as actionable.
          const wasApplied = m.discarded || actions.length === 0 || appliedSet.size > 0;
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
    // appliedIndexes are derived from turn.actions itself, so each is in bounds.
    const chosen = appliedIndexes.map((i) => turn.actions[i]!);
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

  const discardTurn = async (turnIndex: number) => {
    const turn = turns[turnIndex];
    if (!turn || turn.kind !== "assistant") return;
    // Optimistically mark the turn resolved (keep actions so it reads "Dismissed").
    setTurns((prev) =>
      prev.map((t, i) =>
        i === turnIndex && t.kind === "assistant"
          ? { ...t, applied: true, appliedAt: undefined }
          : t,
      ),
    );
    // Persist the rejection so it doesn't reappear after reload.
    if (turn.messageId) {
      try {
        await discardFn({ data: { folder_id: folder.id, message_id: turn.messageId } });
      } catch (err: unknown) {
        const m = err instanceof Error ? err.message : "Couldn't discard changes";
        toast.error(m);
      }
    }
  };

  return (
    <div className="flex h-[28rem] flex-col overflow-hidden rounded-md border border-border">
      <ScrollArea className="min-h-0 flex-1">
        <div ref={scrollRef} className="space-y-4 px-3 py-4">
          {hydrating && (
            <div className="flex items-center gap-2 px-1 py-2 text-xs text-muted-foreground">
              <Spinner className="h-3.5 w-3.5" /> Loading conversation…
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
                          onClick={() => void discardTurn(i)}
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
                            <Spinner className="mr-1 h-3.5 w-3.5" />
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
                <Spinner className="inline h-3.5 w-3.5" /> Thinking…
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
