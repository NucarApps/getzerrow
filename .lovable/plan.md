## Problem

Reanalyzing the calendar invite kept it in **Notifications** even though an **Invitation** folder with AI instructions now exists. The AI classifier never ran.

## Root cause

In `classifyParsedEmail` (`src/lib/sync.server.ts` L197–202), before AI is considered, this short-circuit fires:

```ts
const labeledFolder = folderList.find(
  (f) => f.gmail_label_id && parsed.raw_labels?.includes(f.gmail_label_id)
);
if (labeledFolder) { /* classified_by = "gmail_label", skip AI */ }
```

When this email was first classified into Notifications, we applied the Notifications Gmail label and stored it in `raw_labels`. On Reanalyze, that label is still present, so the classifier matches Notifications immediately and skips the AI step — meaning the new Invitation folder never gets a chance.

This is correct behavior for *new* incoming mail (respect existing Gmail labels), but wrong for an explicit user-initiated **Reanalyze**, where the user is asking us to reconsider with the current rules.

## Fix

Add an opt-in flag to `classifyParsedEmail` and pass it from `reanalyzeEmail` only.

### `src/lib/sync.server.ts`
- Add a second arg-style option: `classifyParsedEmail(parsed, userId, accountId, opts?: { skipGmailLabelMatch?: boolean })`.
- When `opts.skipGmailLabelMatch` is true, skip the `labeledFolder` lookup at L197–202 and fall through to filters → AI.
- Leave all other branches (`global_exclude` override, filter match, `excluded` rule) unchanged — those reflect explicit user intent and should still win over AI.

### `src/lib/gmail.functions.ts` (`reanalyzeEmail`, ~L1011)
- Call `classifyParsedEmail(parsed, context.userId, email.gmail_account_id, { skipGmailLabelMatch: true })`.

## Out of scope

- `processGmailMessage` (initial ingest) keeps the gmail_label shortcut — unchanged.
- The existing "kept current folder when AI returns null" guard at L1035–1050 stays as-is.
- No schema, migrations, or new dependencies.

## Expected behavior after fix

Reanalyzing the calendar invite will bypass the stale Notifications label, run the AI classifier against all folders (including Invitation with its AI rule), and move the email if Invitation is a better match — otherwise the existing "kept" guard leaves it in Notifications and shows the proper toast.
