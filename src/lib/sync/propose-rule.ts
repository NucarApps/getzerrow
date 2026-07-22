// "Rule from example email" proposal parsing (rules upgrade, task 11).
//
// The AI's reply is UNTRUSTED OUTPUT: it is Zod-validated against a
// strict shape before anything touches it, then re-checked with the
// same validateRuleNode bounds gate the save path uses. Proposals may
// only carry the safe flag-like action subset — the model can never
// propose a webhook, an outbound email, or any action that reaches
// outside the mailbox. On any shape violation the caller falls back to
// a deterministic domain rule built from the example email itself.
import { z } from "zod";
import { validateRuleNode } from "./filter-engine";
import type { RuleNode } from "./types";

/** Actions the AI may propose — flag-like only, never network/outbound. */
export const PROPOSABLE_ACTIONS = ["archive", "mark_read", "star"] as const;
export type ProposableAction = (typeof PROPOSABLE_ACTIONS)[number];

export type RuleProposal = {
  suggested_folder_name: string;
  filter_tree: RuleNode;
  actions: ProposableAction[];
  /** True when the AI proposal was rejected and the deterministic
   * domain-rule fallback was used instead. */
  fallback: boolean;
};

const condSchema = z.object({
  type: z.literal("cond"),
  field: z.string().min(1).max(40),
  op: z.string().min(1).max(40),
  value: z.string().min(1).max(500),
});

const ruleNodeSchema: z.ZodType<RuleNode> = z.lazy(() =>
  z.union([
    condSchema,
    z.object({
      type: z.literal("group"),
      op: z.enum(["and", "or"]),
      children: z.array(ruleNodeSchema).min(1).max(32),
    }),
  ]),
);

const proposalSchema = z.object({
  suggested_folder_name: z.string().min(1).max(120),
  filter_tree: ruleNodeSchema,
  actions: z.array(z.enum(PROPOSABLE_ACTIONS)).max(3).default([]),
});

/** Parse + validate a raw AI reply. Returns null on ANY shape or
 * bounds violation — the caller must fall back deterministically. */
export function parseProposal(raw: string): RuleProposal | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  const result = proposalSchema.safeParse(parsed);
  if (!result.success) return null;
  // Same bounds gate as the save path (depth/leaf caps) — a proposal
  // that couldn't be saved must not be offered.
  const bounds = validateRuleNode(result.data.filter_tree);
  if (!bounds.ok) return null;
  return { ...result.data, actions: [...new Set(result.data.actions)], fallback: false };
}

/** Deterministic fallback: a domain (or exact-sender) rule built from
 * the example email — always valid, never AI-derived. */
export function buildFallbackProposal(email: {
  from_addr: string | null;
  from_name: string | null;
}): RuleProposal {
  const addr = (email.from_addr ?? "").toLowerCase();
  const domain = addr.includes("@") ? addr.split("@")[1] : "";
  const name =
    (email.from_name ?? "").trim() || (domain ? domain.split(".")[0] : "") || "New folder";
  const filter_tree: RuleNode = domain
    ? { type: "cond", field: "domain", op: "equals", value: domain }
    : { type: "cond", field: "from", op: "equals", value: addr || "unknown@example.com" };
  return {
    suggested_folder_name: name.charAt(0).toUpperCase() + name.slice(1, 60),
    filter_tree,
    actions: [],
    fallback: true,
  };
}
