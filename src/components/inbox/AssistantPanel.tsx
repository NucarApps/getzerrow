// AI assistant chat panel for the inbox. Users describe how they want
// emails sorted; the AI returns a structured proposal (move emails, add or
// remove filter rules, refine folder rules); the user reviews and approves
// individual actions before anything is written.
import { useMemo, useRef, useState, useEffect } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Sparkles, Send, Check, X, Loader2 } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { proposeAssistantChanges, applyAssistantChanges } from "@/lib/ai-assistant.functions";

type Action =
  | { type: "move_email"; email_id: string; to_folder_id: string; why: string }
  | {
      type: "move_matching";
      field: "from" | "domain" | "subject";
      op: "contains" | "equals" | "starts_with";
      value: string;
      to_folder_id: string;
      why: string;
    }
  | {
      type: "add_filter";
      folder_id: string;
      field: "from" | "domain" | "subject";
      op: "contains" | "equals" | "starts_with";
      value: string;
      why: string;
    }
  | { type: "remove_filter"; filter_id: string; why: string }
  | { type: "update_folder_rule"; folder_id: string; ai_rule: string; why: string }
  | { type: "update_folder_profile"; folder_id: string; learned_profile: string; why: string };

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
    };

type AssistantFolder = { id: string; name: string };

type AssistantEmailMeta = {
  id: string;
  from_name: string | null;
  from_addr: string | null;
  subject: string | null;
};

type AssistantPanelProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string | null;
  folders: AssistantFolder[];
  selectedEmails: AssistantEmailMeta[];
};

function folderName(folders: AssistantFolder[], id: string): string {
  return folders.find((f) => f.id === id)?.name ?? "(unknown folder)";
}

function describeAction(
  action: Action,
  folders: AssistantFolder[],
  emails: AssistantEmailMeta[],
): string {
  if (action.type === "move_email") {
    const e = emails.find((x) => x.id === action.email_id);
    const who = e?.from_name || e?.from_addr || "this email";
    return `Move "${e?.subject ?? "email"}" from ${who} → ${folderName(folders, action.to_folder_id)}`;
  }
  if (action.type === "move_matching") {
    return `Move all where ${action.field} ${action.op} "${action.value}" → ${folderName(folders, action.to_folder_id)}`;
  }
  if (action.type === "add_filter") {
    return `Add filter on "${folderName(folders, action.folder_id)}": ${action.field} ${action.op} "${action.value}"`;
  }
  if (action.type === "remove_filter") {
    return `Remove an existing filter rule`;
  }
  if (action.type === "update_folder_profile") {
    return `Refine learned profile for "${folderName(folders, action.folder_id)}"`;
  }
  return `Update AI rule for "${folderName(folders, action.folder_id)}"`;
}

export function AssistantPanel({
  open,
  onOpenChange,
  accountId,
  folders,
  selectedEmails,
}: AssistantPanelProps) {
  const qc = useQueryClient();
  const proposeFn = useServerFn(proposeAssistantChanges);
  const applyFn = useServerFn(applyAssistantChanges);

  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [applyingIndex, setApplyingIndex] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Keep chat scrolled to the bottom as new turns arrive.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, busy]);

  const history = useMemo(
    () =>
      turns
        .filter(
          (t) =>
            t.kind === "user" || (t.kind === "assistant" && (t.content || t.clarifyingQuestion)),
        )
        .map<{
          role: "user" | "assistant";
          content: string;
        }>((t) =>
          t.kind === "user"
            ? { role: "user", content: t.content }
            : { role: "assistant", content: t.content || t.clarifyingQuestion },
        ),
    [turns],
  );

  const send = async () => {
    const msg = input.trim();
    if (!msg || !accountId || busy) return;
    setInput("");
    setBusy(true);
    setTurns((prev) => [...prev, { kind: "user", content: msg }]);
    try {
      const proposal = (await proposeFn({
        data: {
          gmail_account_id: accountId,
          user_message: msg,
          history,
          selected_email_ids: selectedEmails.map((e) => e.id),
        },
      })) as Proposal;
      setTurns((prev) => [
        ...prev,
        {
          kind: "assistant",
          content: proposal.reply,
          clarifyingQuestion: proposal.clarifying_question,
          actions: proposal.actions,
          selected: proposal.actions.map(() => true),
          applied: false,
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
    }
  };

  const applyTurn = async (turnIndex: number) => {
    const turn = turns[turnIndex];
    if (!turn || turn.kind !== "assistant" || applyingIndex !== null) return;
    const chosen = turn.actions.filter((_, i) => turn.selected[i]);
    if (chosen.length === 0) {
      toast.message("Nothing selected to apply.");
      return;
    }
    setApplyingIndex(turnIndex);
    try {
      const res = (await applyFn({ data: { actions: chosen } })) as {
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
      // Refresh inbox + folders so the user sees the move + new filters.
      qc.invalidateQueries({ queryKey: ["emails"] });
      qc.invalidateQueries({ queryKey: ["folders"] });
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
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
        <SheetHeader className="shrink-0 border-b border-border px-4 py-3">
          <SheetTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4 text-primary" />
            Inbox assistant
          </SheetTitle>
          <SheetDescription className="text-xs">
            Describe how mail should be sorted. I'll suggest changes — nothing is saved until you
            approve.
          </SheetDescription>
          {selectedEmails.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {selectedEmails.length === 1 ? (
                <Badge variant="secondary" className="font-normal">
                  Selected:{" "}
                  {selectedEmails[0].from_name || selectedEmails[0].from_addr || "1 email"}
                </Badge>
              ) : (
                <Badge variant="secondary" className="font-normal">
                  {selectedEmails.length} emails selected
                </Badge>
              )}
            </div>
          )}
        </SheetHeader>

        <ScrollArea className="min-h-0 flex-1">
          <div ref={scrollRef} className="space-y-4 px-4 py-4">
            {turns.length === 0 && (
              <div className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-4 text-xs text-muted-foreground">
                Try things like:
                <ul className="mt-2 list-disc space-y-1 pl-4">
                  <li>"These should go to Marketing, not Sales."</li>
                  <li>"Send anything from @acme.com to Clients."</li>
                  <li>"Stop routing newsletters to Receipts."</li>
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
                              id={`turn-${i}-action-${ai}`}
                              checked={turn.selected[ai]}
                              disabled={turn.applied}
                              onCheckedChange={(v) =>
                                setTurns((prev) =>
                                  prev.map((t, ti) =>
                                    ti === i && t.kind === "assistant"
                                      ? {
                                          ...t,
                                          selected: t.selected.map((s, si) =>
                                            si === ai ? v === true : s,
                                          ),
                                        }
                                      : t,
                                  ),
                                )
                              }
                              className="mt-0.5"
                            />
                            <label
                              htmlFor={`turn-${i}-action-${ai}`}
                              className="flex-1 cursor-pointer text-xs leading-snug"
                            >
                              <div className="font-medium text-foreground">
                                {describeAction(action, folders, selectedEmails)}
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
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder={
                accountId
                  ? "Tell the assistant how to sort this…"
                  : "Connect a Gmail account first."
              }
              disabled={!accountId || busy}
              className="min-h-[44px] max-h-32 resize-none text-sm"
              rows={2}
            />
            <Button
              size="icon"
              onClick={() => void send()}
              disabled={!input.trim() || !accountId || busy}
            >
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
