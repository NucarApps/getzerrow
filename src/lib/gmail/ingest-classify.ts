// Where a Gmail-ingested message should land, as a pure decision.
//
// Two ingest paths — searchGmailAndIngest (pull a Gmail search into the local
// corpus) and scanGmailForFolder (backfill one folder from Gmail) — each had
// their own copy of this precedence. Copies of a routing decision drift, and
// this one decides where a user's mail goes.
//
// Extracted pure (no Gmail API, no DB) so the precedence itself is testable;
// the surrounding fetch/upsert loop lives in ingest-run.ts.
import { matchByFilters } from "../sync/filter-engine";
import type { Filter, Folder } from "../sync/types";

/** The parsed-message fields the routing decision reads. */
export type IngestCandidate = {
  from_addr: string | null;
  from_name: string | null;
  to_addrs: string | null;
  subject: string | null;
  body_text: string | null;
  has_attachment: boolean;
  raw_labels: string[] | null;
};

export type IngestClassification = {
  folder_id: string | null;
  classified_by: string;
  classification_reason: string | null;
  matched_filter_ids: string[];
};

export type IngestClassifyContext = {
  /** Gmail label id -> folder id, for folders linked to a Gmail label. */
  labelToFolder: Map<string, string>;
  folders: Folder[];
  filters: Filter[];
  /** Reason recorded when nothing matched — describes why we fetched it. */
  seedReason: string;
  /**
   * When set, a rule-group match names the folder in its reason
   * ("Rule group matched for \"Clients\""). scanGmailForFolder does this;
   * searchGmailAndIngest leaves it off and says just "Rule group matched".
   */
  nameTreeMatches?: boolean;
  /** Fallback folder name used in a tree-match reason when the id is unknown. */
  fallbackFolderName?: string;
};

/** Seed value before anything matches. */
export const INGEST_SEED_CLASSIFIED_BY = "gmail_search_ingest";

/**
 * Decide the folder for one ingested message.
 *
 * Precedence, highest first:
 *  1. A Gmail label the user has linked to a folder — they already filed it.
 *  2. The shared filter engine (domain allowlists, exclude/veto ops, AND/OR
 *     rule trees, filter_logic, folder priority).
 *  3. Nothing: stays unfiled with the seed reason.
 *
 * NOTE the candidate is a PARTIAL email: ingest has no cc, list_id, is_reply or
 * sender_group_ids, so filters on those fields cannot match here. That is
 * pre-existing behavior on both ingest paths, preserved deliberately.
 */
export function classifyIngestedMessage(
  p: IngestCandidate,
  ctx: IngestClassifyContext,
): IngestClassification {
  for (const lbl of p.raw_labels ?? []) {
    const fid = ctx.labelToFolder.get(lbl);
    if (fid) {
      return {
        folder_id: fid,
        classified_by: "gmail_label",
        classification_reason: "Matched Gmail label",
        matched_filter_ids: [],
      };
    }
  }

  const result = matchByFilters(
    {
      from_addr: p.from_addr ?? "",
      from_name: p.from_name ?? "",
      to_addrs: p.to_addrs ?? "",
      subject: p.subject ?? "",
      body_text: p.body_text ?? "",
      has_attachment: !!p.has_attachment,
    },
    ctx.folders,
    ctx.filters,
  );

  if (result?.kind !== "match") {
    return {
      folder_id: null,
      classified_by: INGEST_SEED_CLASSIFIED_BY,
      classification_reason: ctx.seedReason,
      matched_filter_ids: [],
    };
  }

  const matched_filter_ids = result.matched_filters.map((f) => f.id);

  if (result.tree_used) {
    const named = ctx.nameTreeMatches
      ? ` for "${ctx.folders.find((f) => f.id === result.folder_id)?.name ?? ctx.fallbackFolderName ?? ""}"`
      : "";
    return {
      folder_id: result.folder_id,
      classified_by: "filter",
      classification_reason: `Rule group matched${named}`,
      matched_filter_ids,
    };
  }

  if (result.filter) {
    const isDomain = result.filter.field === "domain";
    return {
      folder_id: result.folder_id,
      classified_by: isDomain ? "domain_rule" : "filter",
      classification_reason: isDomain
        ? `Domain rule: ${result.filter.value}`
        : `Folder rule: ${result.filter.field} ${result.filter.value}`,
      matched_filter_ids,
    };
  }

  return {
    folder_id: result.folder_id,
    classified_by: "filter",
    classification_reason: "Folder rule matched",
    matched_filter_ids,
  };
}
