# Stop always-inbox overrides from resurrecting old mail

## Goal

An "always send to inbox" override (e.g. the domain rule for `nucar.com`) should only affect **newly-arriving** mail. It must never reach into Gmail and re-add the `INBOX` label to messages you already archived. Per your choice, no cleanup of already-resurfaced emails — just stop it going forward.

## Root cause (confirmed)

`src/lib/sync/process-message.ts` (the `else if` branch around lines 328–357) restores a message to the inbox whenever it matches an `inbox_override` / `calendar_contact` classification and is not currently in the Gmail inbox — with **no check on how old the message is**. For historical mail (backfilled, reconciled, or re-synced) this:

1. Calls `modifyMessage(..., ["INBOX"], [])` — writes the `INBOX` label back into real Gmail.
2. Sets `is_archived: false` and adds `INBOX` to `raw_labels` locally.

Once the label is back in Gmail, `reconcileInboxFromGmail`'s incoming pass treats it as legitimately in the inbox and keeps resurfacing it, creating the oscillation you saw.

## The fix

### 1. Add a recency guard to the automatic restore (primary change)

In `src/lib/sync/process-message.ts`, gate the inbox-override restore branch on the message being a genuine recent arrival. Only restore when `received_at` is within a short window (proposed: **3 days**). Old mail is left exactly as Gmail has it (archived), and **no Gmail label write happens**.

```text
const RESTORE_INBOX_WINDOW_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

} else if (
    (classifiedBy === "inbox_override" || classifiedBy === "calendar_contact") &&
    !inInbox
) {
    const receivedMs = Date.parse(parsed.received_at ?? "");
    const isRecentArrival =
        Number.isFinite(receivedMs) &&
        Date.now() - receivedMs < RESTORE_INBOX_WINDOW_MS;

    if (isRecentArrival) {
        // existing restore logic: modifyMessage add INBOX + set is_archived=false
    }
    // else: leave the row archived (upsert already set is_archived = !inInbox = true).
    // Respect Gmail's current state for historical mail — never re-add INBOX.
}
```

Why recency rather than a "backfill" flag: historical mail reaches this branch through several paths (deep backfill, `reconcileInboxFromGmail` re-ingestion at live priority, history catch-up). A `received_at` recency check covers all of them, while still restoring legitimately-new mail that a Gmail filter pre-archived.

### 2. Keep user-initiated restores intact

The explicit, user-triggered paths in `src/lib/gmail.functions.ts` are left as-is, because they only act on emails the user is actively reclassifying and only touch messages currently filed in a folder (`folder_id` set), never archived historical mail:

- `reanalyzeEmail` (single "Reanalyze")
- `reclassifyEmails` (bulk reclassify)
- `addInboxOverride` with `reprocess_past` (only runs when you explicitly add an override and ask to reprocess past mail)
- `moveEmailToInbox` (manual "Move to Inbox")

No change there — those remain deliberate, user-driven actions.

## What this fixes

- New mail from always-inbox senders/domains still lands in the inbox, even if a Gmail filter tried to archive it.
- Historical mail you already archived is never pulled back, and the `INBOX` label is never re-stamped onto old messages in Gmail — which breaks the resurrection loop at its source.

## What this does NOT do (per your choice)

- It does not re-archive or strip `INBOX` from the ~20k override emails or the 127 already resurfaced today. They stay as they are; if any remain in your inbox you can archive them manually. (We can run a targeted cleanup later if you change your mind.)

## Verification

- Re-check the account after deploy: confirm no new pre-2026 emails get `is_archived = false` / `INBOX` re-added on subsequent sync/reconcile ticks.
- Confirm a freshly-arriving test email from an always-inbox domain still appears in the inbox.

## Technical notes

- Single-file behavioral change: `src/lib/sync/process-message.ts`.
- `received_at` is already parsed and stored before this branch, so the guard adds no extra fetch.
- The window constant (3 days) is conservative — large enough to absorb push/poll delays and short outages, far smaller than the months/years-old mail being resurrected.
