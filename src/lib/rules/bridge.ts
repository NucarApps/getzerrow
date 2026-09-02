// The bridge from today's stored config to the amended engine (Phase E).
//
// classify.ts holds an AccountContext (folders, folder_filters,
// inbox_overrides, override exceptions, sender groups); the engine wants
// folders/rules/pins/guardrails. The adapters in ./adapt.ts do the plain
// mapping; this module adds the three legacy escapes that have no direct
// engine concept, so a shadow run disagrees only where the amendments
// intend it to:
//
//   * override exceptions — an always-inbox override with a matching
//     exception is not a pin at all, so it is dropped before stage 2.
//   * overrides_inbox_override — a folder allowed to beat the inbox list.
//     When such a folder has a matching rule, the pin is dropped so the
//     rule stage can win.
//   * sender groups — resolved onto the message so `sender_in_group`
//     conditions evaluate without a second round trip.
//
// PURE: no Supabase, no AI, no clock. Import from anywhere.
import { applyFilter, type EmailForFilter } from "../sync/filter-engine";
import type { AccountContext } from "../sync/account-context";
import type { Folder } from "../sync/types";
import { toCalendarGuardrails, toEngineFolder, toGuardrails, toPins, toRules } from "./adapt";
import { evaluate } from "./evaluate";
import { evaluateRule } from "./resolve";
import type {
  EngineMessage,
  EvaluateContext,
  EvaluateResult,
  Pin,
  ThreadDecision,
  Trigger,
} from "./types";

/** The subset of a parsed email the bridge needs. Structurally satisfied
 * by ParsedEmailForClassify and by any stored email row. */
export type BridgeMessage = EmailForFilter & {
  raw_labels?: string[] | null;
  thread_id?: string | null;
};

export function toEngineMessage(parsed: BridgeMessage, context: AccountContext): EngineMessage {
  const from = (parsed.from_addr || "").toLowerCase();
  const groups = parsed.sender_group_ids ?? Array.from(context.senderGroups.get(from) ?? []);
  return { ...parsed, sender_group_ids: groups, raw_labels: parsed.raw_labels ?? null };
}

const matchesCondition = (m: EngineMessage, c: { field: string; op: string; value: string }) =>
  applyFilter(m, { id: "", folder_id: "", field: c.field, op: c.op, value: c.value });

/** Pins for this message: always-inbox overrides, minus the ones a
 * matching exception cancels, minus every pin a folder is explicitly
 * allowed to beat. */
export function pinsForMessage(
  m: EngineMessage,
  context: AccountContext,
  rules: ReturnType<typeof toRules>,
): Pin[] {
  const overridingFolderIds = new Set(
    context.folders.filter((f: Folder) => f.overrides_inbox_override === true).map((f) => f.id),
  );
  const beaten =
    overridingFolderIds.size > 0 &&
    rules.some((r) => overridingFolderIds.has(r.folder_id) && evaluateRule(r, m).matched);

  return toPins(context.overrides).filter((pin) => {
    const source = context.overrides.find((o) => o.id === pin.id);
    if (!source) return false;
    const cancelled = context.overrideExceptions
      .filter((e) => e.override_id === source.id)
      .some((e) => matchesCondition(m, e));
    return !cancelled && !beaten;
  });
}

export type BridgeOptions = {
  trigger: Trigger;
  aiEnabled: boolean;
  labeledFolderId?: string | null;
  skipGmailLabelMatch?: boolean;
  threadEmails?: EmailForFilter[];
  threadDecision?: ThreadDecision | null;
};

/** Assemble the engine's context for one message. */
export function buildEvaluateContext(
  m: EngineMessage,
  context: AccountContext,
  opts: Pick<BridgeOptions, "threadEmails" | "threadDecision"> = {},
): EvaluateContext {
  const rules = toRules(context.folders, context.filters);
  return {
    folders: context.folders.map(toEngineFolder),
    rules,
    pins: pinsForMessage(m, context, rules),
    guardrails: [
      ...toGuardrails(context.filters),
      ...toCalendarGuardrails(context.folders, context),
    ],
    threadDecision: opts.threadDecision ?? null,
    threadMessages: (opts.threadEmails ?? []) as EngineMessage[],
  };
}

/** Run the amended engine against today's config. */
export function runRulesEngine(
  parsed: BridgeMessage,
  context: AccountContext,
  opts: BridgeOptions,
): EvaluateResult {
  const message = toEngineMessage(parsed, context);
  const evaluateContext = buildEvaluateContext(message, context, opts);
  return evaluate(message, evaluateContext, {
    trigger: opts.trigger,
    aiEnabled: opts.aiEnabled,
    labeledFolderId: opts.labeledFolderId ?? null,
    skipGmailLabelMatch: opts.skipGmailLabelMatch,
  });
}
