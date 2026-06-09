# Fix: re-processed emails from always-inbox senders stay stuck in Factory

## What's happening

The email from `jfranco@nucar.com` should land in the inbox because this account has an always-inbox **domain** override for `nucar.com`. I confirmed in the database:

- Account `45e39731…` has an active `inbox_overrides` row: domain = `nucar.com`.
- The `jfranco@nucar.com` emails are sitting in the **Factory** folder, `classified_by = ai`, `is_archived = true`.
- No folder filter matches `nucar.com`, no override exception exists, and no folder has `overrides_inbox_override` enabled — so the override genuinely should win.

## Root cause

The refresh/re-process icon on a single open email calls **`reanalyzeEmail`** (in `src/lib/gmail.functions.ts`), which is a *different* function from the bulk `reclassifyEmails` we fixed previously.

Inside `reanalyzeEmail`, when the classifier returns `folder_id = null` (which is exactly what an always-inbox override returns), the code hits this guard:

```text
if (result.folder_id === null && email.folder_id) {
  // "Classifier found no better folder — kept current assignment"
  return { ..., classified_by: "kept", changed: false }
}
```

So it treats the inbox-override win as "no better folder found" and leaves the email in Factory. The bulk reclassify path was already fixed for this; the single-email path was missed.

## The fix

In `reanalyzeEmail`, before the "keep current assignment" guard, add a branch that handles the inbox-override case — mirroring the logic already used in `reclassifyEmails` and `moveEmailToInbox`:

When `result.classified_by === "inbox_override"` AND `result.folder_id === null` AND the email currently has a `folder_id`:

1. Look up the current folder's `gmail_label_id`.
2. Recompute `raw_labels`: drop the old folder label, add `INBOX` (via a `Set` dedupe).
3. Update the email row: `folder_id = null`, `is_archived = false`, `classified_by = "inbox_override"`, `ai_confidence = 1`, `matched_filter_ids = []`, new `raw_labels`, and the override classification reason (plus the summary).
4. Best-effort `modifyMessage` to add `INBOX` and remove the old folder label in Gmail (wrapped in try/catch with `logError`).
5. Return `{ ok: true, folder_id: null, classified_by: "inbox_override", changed: true }`.

All other behavior stays the same:
- Genuine "no better folder" abstentions (AI no-match, excluded-by-rule, etc.) still keep the current assignment.
- Folder-to-folder reanalysis is unchanged.

## Verification

- Open the `jfranco@nucar.com` email and hit re-process → it should leave Factory, return to the inbox, and the badge should read inbox-override instead of `AI · 95%`.
- In Gmail the message should regain the `INBOX` label and lose the Factory label.
- Re-processing an email that legitimately matches no folder and isn't an override still stays put.

## Scope

Single file: `src/lib/gmail.functions.ts` (`reanalyzeEmail` only). No database or UI changes.
