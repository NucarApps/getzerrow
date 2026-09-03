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
  "reanalyze-overrides-gmail-label-filing": {
    what: "reanalyzeEmail re-derives the folder with skipGmailLabelMatch:true, so the Gmail label mirror never runs. Mail the user filed by applying a label in Gmail — which the live pipeline files by label on every pass — is silently refiled by whatever rule wins instead, and its Gmail labels are swapped to match.",
    fixIn:
      "src/lib/gmail/move.functions.ts — route reanalyze through persistDecision, or run the label mirror during a re-derive.",
  },
  "calendar-window-hides-colour-skipped-events": {
    what: 'listCalendarEventsWindow drops colour-skipped events in the same filter that removes all-day and hidden-type entries, before annotateEvent runs. annotateEvent\'s `colorSkipped` is therefore always false, the ladder\'s `skipReason = "color"` branch is dead, and the UI\'s "Event color turned off" copy can never be shown. A user who switches a colour off sees those meetings vanish from the calendar list with no explanation.',
    fixIn:
      "src/lib/meetings-autojoin.server.ts — keep colour-skipped events in the window listing and let the skip ladder label them (the upcoming-list filter can stay).",
  },
  "etag-conflict-ignores-google-reason": {
    what: "PeopleApiError.isEtagConflict matches only against `message`, while its siblings isExpiredSyncToken and isMissingScope match against message + googleReason. `call()` builds the message from the response body truncated to 400 characters, so a long People API error pushes Google's FAILED_PRECONDITION out of the message even though parseReason still captured it — the push loop then treats a stale-etag rejection as a hard failure instead of pulling and retrying.",
    fixIn:
      "src/lib/google-contacts/people-client.server.ts — read googleReason in isEtagConflict like the other two predicates do.",
  },
  "reclassify-skips-gmail-labels": {
    what: "reclassifyEmails writes emails.folder_id but never swaps the Gmail labels, so the DB and the mailbox drift apart. Its single-message sibling reanalyzeEmail does swap them.",
    fixIn: "src/lib/gmail/rules.functions.ts — route the bulk path through performMove.",
  },
  "create-folder-assign-hand-rolled-patch": {
    what: "createFolderAndAssign assembles its own emails patch instead of calling performMove: the old folder's Gmail label stays on the message and matched_filter_ids is left stale.",
    fixIn: "src/lib/gmail/rules.functions.ts — assign through performMove.",
  },
  "run-jobs-now-drains-global-queue": {
    what: "runJobsNow passes a client-chosen limit (up to 100) straight to runMessageJobs, whose claim_message_jobs RPC takes only a limit and a priority — no user id. Any authenticated user can therefore drain the shared queue on behalf of every tenant and read back the aggregate processed/failed/dlq counts of work that is not theirs.",
    fixIn:
      "src/lib/gmail/rules.functions.ts and src/lib/sync/run-jobs.ts — claim only the caller's jobs (a p_user_id argument on claim_message_jobs), or make the UI button enqueue a scoped drain.",
  },
  "domain-reassign-not-transactional": {
    what: "reassignDomainToFolder inserts the destination domain rule BEFORE the bulk email update, so a failing update throws but leaves the new rule behind.",
    fixIn:
      "src/lib/gmail/domain.functions.ts — write the rule after the moves succeed, or roll it back.",
  },
  "folder-chat-skips-conflict-check": {
    what: "applyFolderChanges inserts folder_filters directly without calling checkRuleConflicts, so a rule created from chat can silently shadow an existing one — the rules editor warns.",
    fixIn: "src/lib/folder-chat.functions.ts — run checkRuleConflicts before inserting.",
  },
  "carddav-addressbook-query-filter-ignored": {
    what: "addressbook-query now evaluates prop-filter/text-match on FN, EMAIL, TEL and UID (match-type, negate-condition, anyof/allof). Everything else — is-not-defined, param-filter, any other property name, a non-default collation, an unknown match-type, and <D:limit> on a query — is answered with the WHOLE collection rather than a wrong subset. A superset is safe but the client still downloads the book to narrow it, and it is silent: nothing tells the client its filter was not applied.",
    fixIn:
      "src/lib/carddav/query-filter.ts — widen the grammar, and consider a 403 supported-filter precondition (RFC 6352 §8.6.2) for what stays unimplemented.",
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
  "inbox-override-duplicate-unguarded": {
    what: "Adding an always-inbox entry does not look at the entries already on the list, so a repeat is only caught by inbox_overrides' UNIQUE (user_id, match_type, value). That key predates the gmail_account_id column and still ignores it, so the same domain cannot be listed on two Gmail accounts at all — and either way the user is shown the raw Postgres unique-violation text instead of a sentence.",
    fixIn:
      "src/lib/ui/inbox-overrides.ts and supabase/migrations — widen the unique key to include gmail_account_id and report a duplicate in the validator.",
  },
  "suggested-merge-skips-google-tombstones": {
    what: "mergeContactDuplicate skips a Google link whose gmail_account_id the survivor already holds, then deletes the duplicate contact — the link row disappears by FK cascade and nothing is recorded in google_contact_tombstones. The Google-side duplicate is never deleted upstream and comes back on the next pull. Its sibling mergeContactsManual tombstones exactly those collision resources, so the two merge paths disagree.",
    fixIn:
      "src/lib/contacts/dedup.functions.ts — tombstone the colliding resources in mergeContactDuplicate the way the manual merge does.",
  },
  "reports-topsenders-address-only": {
    what: "getInboxReport never selects a sender display name, so parseSender's name branch is dead and topSenders can only ever show an address. There is no plaintext from_name column — only from_name_enc — so the fix is a decrypt pass over the window, not a wider select.",
    fixIn: "src/lib/reports.functions.ts — resolve display names via the decrypt reader.",
  },
  "card-analytics-daily-adds-out-of-window-day": {
    what: "getMyCardAnalytics prefills one bucket per calendar day but filters the query at a timestamp exactly days*24h ago, so an event from earlier in the day at the far end of the window passes the filter, finds no prefilled bucket and creates one. `daily` then carries rangeDays + 1 entries, and the extra leading day is a partial count the chart draws as if it were a whole one.",
    fixIn:
      "src/lib/card-analytics.functions.ts — cut `since` to the start of the oldest prefilled day, or drop events with no prefilled bucket.",
  },
  "card-lead-public-writes-unthrottled": {
    what: "submitCardLead and logCardEvent are unauthenticated server fns with no rate limit, captcha or per-handle quota. Knowing a public handle is enough to insert contacts and card_events rows for that handle's owner indefinitely; knowing one of the owner's contact addresses as well is enough to append 1000 characters into that contact's encrypted notes on every call, growing the row without bound and burying the owner's real notes.",
    fixIn:
      "src/lib/cards.functions.ts and src/lib/card-analytics.functions.ts — throttle per handle and per source address (a product decision: quota, captcha, or an owner-facing approval queue).",
  },
  "vcard-esc-leaves-carriage-return": {
    what: "cards.server's esc() folds \\ , ; and \\n but not \\r, while buildVCard joins its lines with CRLF. A card field containing a carriage return (nothing in the my_cards validators forbids one) is emitted raw into the vCard, so the file a recipient imports carries a stray CR mid-value. Its sibling escaper in carddav/vcard.ts folds the whole CRLF pair (/\\r?\\n/), which is what this one should do.",
    fixIn: "src/lib/cards.server.ts — drop or escape \\r in esc() alongside \\n.",
  },
  "webhook-duplicate-logs-spurious-push-empty": {
    what: "The Gmail push webhook's duplicate-delivery short-circuit returns from inside the try block, so the finally block still runs and writes a second pubsub_events row — a `push_empty` summary with a null payload, null subscription and null counts. `push_empty` means 'the envelope carried no message.data', so every Pub/Sub redelivery inflates that count in the Settings activity panel and in any push-health query built on it.",
    fixIn:
      "src/routes/api/public/gmail-webhook.ts — take the duplicate path out of the try/finally, or flag it so the summary write is skipped.",
  },
  "inbox-day-heading-repeats-after-placeholder": {
    what: "dayGroupHeadings compares each row's day against the row immediately above it, and a placeholder row (rebuilt from the metadata cache) reports no day at all. A placeholder sitting between two rows of the same day therefore breaks the run and the day heading is drawn a second time mid-list.",
    fixIn:
      "src/lib/ui/inbox-list.ts — compare against the last row that had a day, not the previous row.",
  },
};
