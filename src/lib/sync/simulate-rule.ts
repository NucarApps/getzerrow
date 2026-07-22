// Rule simulator core (rules upgrade, task 10). Pure and deterministic:
// runs the SAME matchByFilters engine the classify path uses, with the
// draft folder + filters overlaid onto the account's real config, and
// reports which of the supplied emails would move into the draft folder,
// which its exclude rules would veto, and how many are untouched.
//
// No AI anywhere in the loop — the simulator must stay fast (<300ms for
// 1k emails) and free, so it only answers what deterministic rules
// would do. AI-classified outcomes are out of scope by design.
import { matchByFilters, collectMatchingLeaves, type EmailForFilter } from "./filter-engine";
import type { Folder, Filter, RuleNode } from "./types";

/** Cap on rows returned per list — counts always cover ALL emails. */
export const SIMULATION_LIST_CAP = 200;

export type SimEmail = EmailForFilter & {
  id: string;
  current_folder_id: string | null;
};

export type SimulatedHit = {
  email_id: string;
  from_addr: string;
  subject: string;
  current_folder_id: string | null;
  matched_leaves: Array<{ field: string; op: string; value: string }>;
};

export type SimulationResult = {
  would_route: SimulatedHit[];
  would_exclude: SimulatedHit[];
  no_change: number;
  moves: number;
  excluded: number;
  scanned: number;
};

export type DraftOverlay = {
  folder: Folder;
  filters: Filter[];
};

/** Overlay the draft onto the existing config: a draft that edits an
 * existing folder replaces that folder's row and filter set; a new
 * draft is appended. */
export function overlayDraft(
  existing: { folders: Folder[]; filters: Filter[] },
  draft: DraftOverlay,
): { folders: Folder[]; filters: Filter[] } {
  const folders = [...existing.folders.filter((f) => f.id !== draft.folder.id), draft.folder];
  const filters = [
    ...existing.filters.filter((f) => f.folder_id !== draft.folder.id),
    ...draft.filters,
  ];
  return { folders, filters };
}

function hit(
  e: SimEmail,
  leaves: Array<{ field: string; op: string; value: string }>,
): SimulatedHit {
  return {
    email_id: e.id,
    from_addr: e.from_addr,
    subject: e.subject,
    current_folder_id: e.current_folder_id,
    matched_leaves: leaves,
  };
}

/** Dry-run the draft against a set of emails. Deterministic — same
 * inputs, same output, in input order. */
export function simulateAgainstEmails(
  emails: SimEmail[],
  draft: DraftOverlay,
  existing: { folders: Folder[]; filters: Filter[] },
): SimulationResult {
  const { folders, filters } = overlayDraft(existing, draft);
  const draftId = draft.folder.id;
  const tree = (draft.folder.filter_tree ?? null) as RuleNode | null;

  const would_route: SimulatedHit[] = [];
  const would_exclude: SimulatedHit[] = [];
  let moves = 0;
  let excluded = 0;

  for (const e of emails) {
    const m = matchByFilters(e, folders, filters);
    if (m?.kind === "excluded" && m.folder_id === draftId) {
      excluded++;
      if (would_exclude.length < SIMULATION_LIST_CAP) {
        would_exclude.push(
          hit(e, [{ field: m.exclude.field, op: m.exclude.op, value: m.exclude.value }]),
        );
      }
      continue;
    }
    if (m?.kind === "match" && m.folder_id === draftId && e.current_folder_id !== draftId) {
      moves++;
      if (would_route.length < SIMULATION_LIST_CAP) {
        const leaves =
          m.tree_used && tree
            ? collectMatchingLeaves(e, tree)
            : m.matched_filters.map((f) => ({ field: f.field, op: f.op, value: f.value }));
        would_route.push(hit(e, leaves));
      }
    }
  }

  return {
    would_route,
    would_exclude,
    no_change: emails.length - moves - excluded,
    moves,
    excluded,
    scanned: emails.length,
  };
}
