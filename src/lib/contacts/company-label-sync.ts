// Pure membership-diff planner for rule-materialized label memberships
// (including "company X is in label G" company_id rules). No I/O — the
// orchestrator in group-rules.functions.ts loads inputs and applies the plan.
//
// Ownership contract: the plan only ever adds/removes rows with
// source='rule'. Manual rows and reconciler-owned rows ('company_subgroup')
// are invisible to removals here; adds skip any pair that already exists
// with ANY source so rows are never demoted or duplicated.
import { matchRules, type ContactSignals, type GroupRule } from "./group-rules";

export type MembershipPair = { group_id: string; contact_id: string };

export function pairKey(groupId: string, contactId: string): string {
  return `${groupId}:${contactId}`;
}

export function planRuleMembershipSync(input: {
  /** Every rule for the user (any type); non-auto rules are ignored. */
  rules: GroupRule[];
  /** Signals for every contact in scope. Contacts outside this map are untouched. */
  signalsByContact: Map<string, ContactSignals>;
  /** Existing source='rule' membership rows for the in-scope contacts. */
  currentRuleRows: MembershipPair[];
  /** pairKey(group,contact) of EVERY existing membership row, any source. */
  existingMemberPairs: Set<string>;
}): { toAdd: MembershipPair[]; toRemove: MembershipPair[] } {
  const autoRules = input.rules.filter((r) => r.auto_apply);

  // Wanted = every (group, contact) justified by at least one auto rule.
  const wanted = new Set<string>();
  const toAdd: MembershipPair[] = [];
  for (const [contactId, signals] of input.signalsByContact) {
    for (const m of matchRules(signals, autoRules)) {
      const key = pairKey(m.groupId, contactId);
      if (wanted.has(key)) continue;
      wanted.add(key);
      if (!input.existingMemberPairs.has(key)) {
        toAdd.push({ group_id: m.groupId, contact_id: contactId });
      }
    }
  }

  // A rule row is removed only when NO auto rule still justifies it — so a
  // contact who left the company but still matches a domain rule stays.
  const toRemove = input.currentRuleRows.filter(
    (p) =>
      input.signalsByContact.has(p.contact_id) && !wanted.has(pairKey(p.group_id, p.contact_id)),
  );

  return { toAdd, toRemove };
}
