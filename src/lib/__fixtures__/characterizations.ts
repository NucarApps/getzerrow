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
  "carddav-multiget-missing-href-omitted": {
    what: "A multiget href naming a contact that does not exist (or belongs to another user) is silently omitted instead of returning a 404 response block for that href.",
    fixIn: "src/lib/carddav/handlers.server.ts",
  },
  "carddav-prop-subset-ignored": {
    what: "PROPFIND ignores the requested prop subset and always returns a fixed set, with no 404 propstat for props it does not have.",
    fixIn: "src/lib/carddav/handlers.server.ts",
  },
  "meeting-stream-secret-unset-throws": {
    what: "verifyRecordingStreamToken signs to compare, and the signer throws when MEETING_STREAM_SECRET is unset. Its route caller is outside a try/catch, so a deployment missing the secret answers 500 instead of 401 and leaks the misconfiguration.",
    fixIn: "src/lib/meeting-stream.server.ts — return false when the secret is missing.",
  },
  "folder-chat-skips-conflict-check": {
    what: "applyFolderChanges inserts folder_filters directly without calling checkRuleConflicts, so a rule created from chat can silently shadow an existing one — the rules editor warns.",
    fixIn: "src/lib/folder-chat.functions.ts — run checkRuleConflicts before inserting.",
  },
  "summary-enqueue-no-dedupe": {
    what: "enqueueFolderSummaryJob always inserts, with no pending-job check and no unique index behind it, so two clicks send two identical digests.",
    fixIn: "src/lib/summaries.server.ts — skip when a pending job exists, or add a unique index.",
  },
  "assistant-prompt-unsanitized-email-text": {
    what: "The inbox assistant's prompt builder interpolates email subject/snippet/from_name without sanitizeUntrustedText, unlike the classifier, so a crafted message reaches the instruction block verbatim.",
    fixIn: "src/lib/ai-assistant.server.ts — wrap untrusted fields the way ai.server.ts does.",
  },
  "folder-chat-prompt-unsanitized-email-text": {
    what: "The folder chat prompt builder interpolates email text without sanitizeUntrustedText, the same gap as the inbox assistant.",
    fixIn: "src/lib/folder-chat.server.ts — wrap untrusted fields the way ai.server.ts does.",
  },
  "carddav-basic-auth-utf8-mangled": {
    what: 'verifyCardDavAuth decodes Basic credentials with atob, which yields a Latin-1 byte string. A UTF-8 email or password comes through as mojibake ("é" becomes "Ã©"), so an account with a non-ASCII address can never pair a phone and the failure is indistinguishable from a wrong password.',
    fixIn:
      'src/lib/carddav/auth.server.ts — decode the base64 bytes with TextDecoder("utf-8") instead of atob alone.',
  },
  "carddav-addressbook-query-filter-ignored": {
    what: "addressbook-query ignores prop-filter/text-match entirely and returns every contact, so a filtering client does its own work over a full download.",
    fixIn: "src/lib/carddav/handlers.server.ts",
  },
  "admin-ignores-email-verified": {
    what: "assertAdmin matches the JWT `email` claim against ADMIN_EMAILS without ever consulting `email_verified`, so an unverified identity that merely asserts an allowlisted address is granted the cross-tenant admin dashboard.",
    fixIn: "src/lib/admin.functions.ts — require claims.email_verified === true.",
  },
  "reports-topsenders-address-only": {
    what: "getInboxReport never selects a sender display name, so parseSender's name branch is dead and topSenders can only ever show an address. There is no plaintext from_name column — only from_name_enc — so the fix is a decrypt pass over the window, not a wider select.",
    fixIn: "src/lib/reports.functions.ts — resolve display names via the decrypt reader.",
  },
};
