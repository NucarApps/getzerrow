// Stage 1: guardrails and exclusions (Amendment 1).
//
// Security codes, 2FA, protected senders and matching exclusions run
// BEFORE anything can file the message. A stage that runs after a
// "file and stop" stage can never veto anything, which is why the old
// ladder's exclusion rung was ineffective for label-mirrored mail.
//
// Two exclusion scopes:
//   global — pins the message to the Inbox and stops the pipeline
//   folder — disqualifies that one folder for every later stage
import { applyFilter, filterVetoes, EXCLUDE_OPS } from "../sync/filter-engine";
import { emailDomain } from "../company-domains";
import type { Condition, EngineMessage, Guardrail } from "./types";

/** Subject/body markers for one-time codes and 2FA challenges. Kept
 * deliberately narrow: this stage pins mail to the Inbox, so a false
 * positive costs a user an automatic filing, and a false negative costs
 * them a missed login code. */
const SECURITY_PATTERNS: RegExp[] = [
  /\b(verification|security|confirmation|access|login|sign[- ]?in)\s+code\b/i,
  /\bone[- ]?time\s+(code|passcode|password|pin)\b/i,
  /\b(2fa|mfa|two[- ]factor|multi[- ]factor)\b/i,
  /\bauthentication code\b/i,
  /\byour code is\b/i,
  /\bverify your (email|identity|account|sign[- ]?in)\b/i,
  /\b\d{6}\s+is your\b/i,
];

/** True when the message looks like a security code / 2FA challenge. Pure
 * and content-only: no config, no network. */
export function isSecurityMessage(m: EngineMessage): boolean {
  const subject = m.subject || "";
  if (SECURITY_PATTERNS.some((r) => r.test(subject))) return true;
  // Body check is bounded so a huge marketing email can't dominate the
  // hot path; codes live at the top of these messages anyway.
  const head = (m.body_text || "").slice(0, 2_000);
  return SECURITY_PATTERNS.some((r) => r.test(head));
}

function conditionMatches(m: EngineMessage, c: Condition): boolean {
  const f = { id: "", folder_id: "", field: c.field, op: c.op, value: c.value };
  return EXCLUDE_OPS.has(c.op) ? filterVetoes(m, f) : applyFilter(m, f);
}

export type GuardrailVerdict =
  | { kind: "pin_inbox"; guardrail: Guardrail; detail: string }
  | { kind: "security"; detail: string }
  | { kind: "none" };

export type GuardrailResult = {
  verdict: GuardrailVerdict;
  /** Folders disqualified for every later stage. */
  vetoedFolderIds: string[];
};

/** Evaluate stage 1. Returns the pin-to-Inbox verdict (if any) and the set
 * of folders vetoed by folder-scoped exclusions. */
export function evaluateGuardrails(
  m: EngineMessage,
  guardrails: Guardrail[],
  detector: (msg: EngineMessage) => boolean = isSecurityMessage,
): GuardrailResult {
  const vetoed = new Set<string>();
  let verdict: GuardrailVerdict = { kind: "none" };

  if (detector(m)) {
    verdict = { kind: "security", detail: "Looks like a security or 2FA code — kept in the Inbox" };
  }

  const fromAddr = (m.from_addr || "").toLowerCase();
  const fromDomain = emailDomain(m.from_addr) ?? "";

  for (const g of guardrails) {
    let hit = false;
    if (g.kind === "protected_sender") {
      const val = (g.label || g.condition?.value || "").toLowerCase().replace(/^@/, "");
      hit = val.includes("@") ? val === fromAddr : val === fromDomain;
    } else if (g.kind === "cold_email_contact") {
      // Someone you have met (a calendar contact) is not cold outreach.
      hit = !!fromAddr && (g.senders ?? []).includes(fromAddr);
    } else if (g.condition) {
      hit = conditionMatches(m, g.condition);
    }
    if (!hit) continue;

    if (g.scope === "folder" && g.folder_id) {
      vetoed.add(g.folder_id);
      continue;
    }
    if (verdict.kind === "none") {
      verdict = {
        kind: "pin_inbox",
        guardrail: g,
        detail:
          g.kind === "protected_sender"
            ? `Protected sender "${g.label ?? g.condition?.value ?? ""}" — kept in the Inbox`
            : `Exclusion "${g.label ?? describeCondition(g.condition!)}" — kept in the Inbox`,
      };
    }
  }

  return { verdict, vetoedFolderIds: Array.from(vetoed) };
}

export function describeCondition(c: Condition): string {
  return `${c.field} ${c.op} "${c.value}"`;
}
