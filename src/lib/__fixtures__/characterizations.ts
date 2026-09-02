// The register of known-wrong behaviour that is currently PINNED by a test.
//
// A characterization test asserts what the code does today, not what it
// should do, so that a fix has to be deliberate: the pin fails, and whoever
// fixes the bug flips it in the same commit.
//
// Why a registry rather than just comments: the September 2026 review found
// seven bugs recorded in a hand-kept note as "pinned" that no test actually
// pinned. `characterization-registry.test.ts` keeps the two sides honest —
// every `CHARACTERIZATION(slug)` marker in a test must appear here, and
// every slug here must still be pinned by a test. Fixing a bug therefore
// means deleting its entry, and a pin cannot rot into a stale note.
//
// Format of a marker: a `// CHARACTERIZATION(<slug>): <what is wrong>`
// comment directly above the `it` it applies to.
//
// Declared divergences between the legacy ladder and the v2 rules engine use
// a different mechanism — `engineDelta` / `ingestDelta` in
// sync/__fixtures__/folder-scenarios.ts, enforced by the agreement suite —
// because those are compared against an oracle rather than pinned by hand.

export type Characterization = {
  /** What the code does today, and why that is wrong. */
  what: string;
  /** Where the fix belongs, so the pin points at its own cure. */
  fixIn: string;
};

export const CHARACTERIZATIONS: Record<string, Characterization> = {
  "catchup-upsert-error-drops-message": {
    what: "Bulk catch-up deletes the queue job as done even when the encrypted row upsert failed, so the message is lost until a reconcile re-ingests it.",
    fixIn: "src/lib/sync/catchup.ts — release the job instead of deleting it on upsert failure.",
  },
  "reclassify-skips-gmail-labels": {
    what: "reclassifyEmails writes emails.folder_id but never swaps the Gmail labels, so the DB and the mailbox drift apart. Its single-message sibling reanalyzeEmail does swap them.",
    fixIn: "src/lib/gmail/rules.functions.ts — route the bulk path through performMove.",
  },
  "create-folder-assign-hand-rolled-patch": {
    what: "createFolderAndAssign assembles its own emails patch instead of calling performMove: the old folder's Gmail label stays on the message and matched_filter_ids is left stale.",
    fixIn: "src/lib/gmail/rules.functions.ts — assign through performMove.",
  },
  "domain-reassign-not-transactional": {
    what: "reassignDomainToFolder inserts the destination domain rule BEFORE the bulk email update, so a failing update throws but leaves the new rule behind.",
    fixIn:
      "src/lib/gmail/domain.functions.ts — write the rule after the moves succeed, or roll it back.",
  },
  "escape-html-quote-and-idempotence": {
    what: "escapeHtml leaves ' unescaped (unsafe inside single-quoted attributes) and is not idempotent — escaping twice double-escapes the entities.",
    fixIn: "src/lib/escape-html.ts",
  },
  "carddav-nresults-token-covers-full-snapshot": {
    what: "A sync-collection REPORT with nresults truncates the change list but still mints a token covering the whole snapshot, so a limit-honouring client permanently misses the truncated contacts. RFC 6578 wants a 507 marker.",
    fixIn:
      "src/lib/carddav/handlers.server.ts — emit 507 and a token covering only what was returned.",
  },
  "folder-chat-skips-conflict-check": {
    what: "applyFolderChanges inserts folder_filters directly without calling checkRuleConflicts, so a rule created from chat can silently shadow an existing one — the rules editor warns.",
    fixIn: "src/lib/folder-chat.functions.ts — run checkRuleConflicts before inserting.",
  },
  "summary-enqueue-no-dedupe": {
    what: "enqueueFolderSummaryJob always inserts, with no pending-job check and no unique index behind it, so two clicks send two identical digests.",
    fixIn: "src/lib/summaries.server.ts — skip when a pending job exists, or add a unique index.",
  },
  "carddav-addressbook-query-filter-ignored": {
    what: "addressbook-query now evaluates prop-filter/text-match on FN, EMAIL, TEL and UID (match-type, negate-condition, anyof/allof). Everything else — is-not-defined, param-filter, any other property name, a non-default collation, an unknown match-type, and <D:limit> on a query — is answered with the WHOLE collection rather than a wrong subset. A superset is safe but the client still downloads the book to narrow it, and it is silent: nothing tells the client its filter was not applied.",
    fixIn:
      "src/lib/carddav/query-filter.ts — widen the grammar, and consider a 403 supported-filter precondition (RFC 6352 §8.6.2) for what stays unimplemented.",
  },
  "admin-ignores-email-verified": {
    what: "assertAdmin matches the JWT `email` claim against ADMIN_EMAILS without ever consulting `email_verified`, so an unverified identity that merely asserts an allowlisted address is granted the cross-tenant admin dashboard.",
    fixIn: "src/lib/admin.functions.ts — require claims.email_verified === true.",
  },
  "replay-ignores-gmail-label-placement": {
    what: "buildChangeSet evaluates every historical message with skipGmailLabelMatch:true, so the Gmail label mirror (stage 3) never runs. Mail the user filed by applying a label in Gmail — which the live pipeline files by label on every pass — reads as unexplained, is proposed for a move to the Inbox, and is not even flagged requires_review, so Apply All (planner-apply applyMoves) would carry it out.",
    fixIn:
      "src/lib/rules/replay.ts — run the label mirror during replay, or mark label-filed mail locked.",
  },
  "rfc2047-headers-not-decoded": {
    what: "parseMessage stores From display names and Subjects exactly as Gmail returns them, so an RFC 2047 encoded-word header reaches the inbox list and the classifier's `from`/`subject` fields as raw =?UTF-8?B?…?= text. Any sender or subject with a non-ASCII character is unreadable in the UI and unmatchable by a rule written against the real name.",
    fixIn: "src/lib/gmail.server.ts — decode encoded words in parseMessage's header reader.",
  },
  "has-attachment-counts-inline-images": {
    what: "parseMessage's has_attachment is a bare filename walk over payload.parts, so an inline logo under multipart/related — which nearly every marketing email carries — sets it. The paperclip in the message list is showing the sender's logo, not a document, and a `has_attachment` folder rule fires on newsletters.",
    fixIn:
      "src/lib/gmail.server.ts — skip parts whose Content-Disposition is inline, or that are referenced by a cid: in the HTML.",
  },
  "backoff-nan-below-table-floor": {
    what: "computeBackoffSeconds' terminal branch indexes BACKOFF_SECONDS with nextAttempt - 1 and clamps only the top of the range, so nextAttempt 0 reads table[-1] === undefined and jitter returns NaN. run-jobs writes `Date.now() + seconds * 1000` into next_run_at, so a NaN there becomes an invalid timestamp on the queue row.",
    fixIn: "src/lib/sync/backoff.ts — clamp the index to 0 as well as to the table length.",
  },
  "engine-tree-rule-has-no-age": {
    what: "folders.filter_tree is a JSON column with no authoring timestamp, so adapt.toRules stamps a tree rule with the epoch. The v2 ladder's last-resort tiebreak is 'the older rule wins', so a tree rule silently out-ages every real folder_filters rule at the same level.",
    fixIn:
      "src/lib/rules/adapt.ts — carry a real created_at once Phase D moves trees into the rules table.",
  },
  "ingest-drops-non-header-filter-fields": {
    what: "classifyIngestedMessage builds its EmailForFilter without cc, list_id or in_reply_to, so a folder rule on cc / list_id / is_reply fires on the arrival path but silently never fires on either Gmail ingest path (searchGmailAndIngest, scanGmailForFolder).",
    fixIn: "src/lib/gmail/ingest-classify.ts — carry the fields through IngestCandidate.",
  },
  "rule-preview-domain-ignores-op": {
    what: "applySimpleRulePredicate's domain/origin_domain branch drops the operator and always builds `%@value%`. `equals` therefore counts any address whose text contains `@value` (including a relayed header whose real sender is a different domain), and `contains` misses a subdomain sender that the engine's emailDomain() match finds. The preview count and the mail that actually gets filed disagree.",
    fixIn:
      "src/lib/gmail/rule-query.ts — honour the op for domain fields the way the subject branch does.",
  },
  "rule-preview-from-equals-is-substring": {
    what: "The preview's `from` branch has no `equals` arm, so an 'is exactly' rule previews as a substring match. The engine is wrong the other way: applyFilter's `from` field is `from_addr + ' ' + from_name`, so `equals` compares against a string with a trailing space and can never match a bare address.",
    fixIn:
      "src/lib/gmail/rule-query.ts and src/lib/sync/filter-engine.ts — give `from` an equals arm on the address alone.",
  },
  "rule-preview-from-ignores-display-name": {
    what: "applyFilter's `from` field concatenates the display name, so `from contains acme` fires on 'Acme Support <noreply@vendor.test>'. The preview only ILIKEs from_addr and cannot reproduce it — from_name is stored encrypted, so there is no column to search.",
    fixIn:
      "src/lib/sync/filter-engine.ts — match `from` on the address only, or add a searchable name column.",
  },
  "meeting-skip-reason-color-has-no-label": {
    what: "resolveRecordingPlan emits a `color` skipReason for a meeting skipped because of its calendar colour, but SKIP_REASON_LABEL has no copy for it, so the meetings list shows a bare 'Not recorded' with no explanation. Every other reason the ladder can produce has its own label.",
    fixIn: "src/lib/ui/meeting-skip-reason.ts — add copy for `color`.",
  },
  "swipe-row-archives-on-touchcancel": {
    what: "SwipeRow binds touchcancel to the same handler as touchend, so a gesture the system aborts — an incoming call, an edge swipe, the browser taking over the scroll — archives the message as if the user had released past the threshold. touchcancel means the gesture did not happen.",
    fixIn:
      "src/components/emails/swipe-row.tsx — give touchcancel its own handler that resets without calling onArchive.",
  },
  "format-unparseable-date-echoed-raw": {
    what: "formatDateTime and formatEventTime return the raw input string when it will not parse, while formatRelativeTime, formatShortDate and formatShortDateTime return the caller's fallback. An unparseable timestamp therefore renders as garbage text in two places and as an em dash in three, and the caller's fallback argument is silently ignored on the first two.",
    fixIn: "src/lib/format.ts — return the fallback from every formatter on NaN input.",
  },
  "folder-history-reports-exclude-rule": {
    what: "The folder history panel explains a filed email with the first folder rule whose leaf evaluates true, without partitioning includes from excludes the way the engine does. An exclude-op rule (not_contains / not_equals / domain_in) evaluates true for exactly the mail it does NOT veto, so a veto rule is routinely named as the rule that filed the email, ahead of the include rule that actually did.",
    fixIn: "src/lib/ui/folder-history.ts — skip filter-engine's EXCLUDE_OPS in matchFilter.",
  },
  "folder-history-surfaced-reason-blank": {
    what: "An email stamped classified_by=surfaced_to_inbox gets a 'Surfaced' badge, but describeReason has no branch for it and falls through to 'Imported with this folder / No classifier ran on this email yet'. The panel contradicts its own badge, and the surface check that filed the mail is never explained.",
    fixIn: "src/lib/ui/folder-history.ts — give describeReason a surfaced_to_inbox branch.",
  },
  "inbox-override-duplicate-unguarded": {
    what: "Adding an always-inbox entry does not look at the entries already on the list, so a repeat is only caught by inbox_overrides' UNIQUE (user_id, match_type, value). That key predates the gmail_account_id column and still ignores it, so the same domain cannot be listed on two Gmail accounts at all — and either way the user is shown the raw Postgres unique-violation text instead of a sentence.",
    fixIn:
      "src/lib/ui/inbox-overrides.ts and supabase/migrations — widen the unique key to include gmail_account_id and report a duplicate in the validator.",
  },
  "reports-topsenders-address-only": {
    what: "getInboxReport never selects a sender display name, so parseSender's name branch is dead and topSenders can only ever show an address. There is no plaintext from_name column — only from_name_enc — so the fix is a decrypt pass over the window, not a wider select.",
    fixIn: "src/lib/reports.functions.ts — resolve display names via the decrypt reader.",
  },
};
