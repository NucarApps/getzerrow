## Problem

The mobile feed endpoint `POST /api/mobile/emails/feed` (`src/routes/api/mobile/emails.feed.ts`) defaults the list `scope` to `"all_mail"`. In the `get_emails_list_decrypted` RPC, `all_mail` bypasses every inbox filter and returns **everything** — messages already filed into folders, archived, snoozed, and still `pending`/`pending_ai`.

The web inbox's main view (`src/routes/_authenticated/inbox.tsx`, line ~621) uses scope `"all"`, which keeps only: unarchived mail carrying the `INBOX` label, not snoozed, not pending, and either surfaced-to-inbox or belonging to a folder that isn't `auto_archive`/`hide_from_inbox`.

That mismatch is why the phone shows "already processed" mail the web app has dropped.

## Fix

Make the mobile feed default to the same inbox view as the web app.

In `src/routes/api/mobile/emails.feed.ts`:

- Change the Zod default for `scope` in the `list` branch from `"all_mail"` to `"all"`, so a mobile client that omits `scope` gets the exact inbox-only view.
- Keep the enum accepting `"all" | "all_mail" | "no_rules" | "folder"` so the app can still request other views explicitly (e.g. a folder view or full-mail search).

No other logic changes: the endpoint already loops over the user's `gmail_accounts`, calls `getEmailsListDecrypted` per account with the chosen scope, merges, sorts by `received_at` desc, and slices to `limit`. Scope `"all"` is fully handled per-account by the RPC (it does the folder join and INBOX/surfaced/hidden filtering), so merging across accounts stays correct.

## Notes

- The rork app itself lives in a separate codebase we don't control here. If it is currently sending `scope: "all_mail"` explicitly, changing the server default won't help — in that case the app must send `scope: "all"` (or omit it). I'll call this out after the change so you can update the rork request if needed.
- No database migration required; the `all` behavior already exists in the `get_emails_list_decrypted` RPC.

### Technical detail

File: `src/routes/api/mobile/emails.feed.ts`
```
scope: z.enum(["all", "all_mail", "no_rules", "folder"]).default("all_mail")
```
becomes
```
scope: z.enum(["all", "all_mail", "no_rules", "folder"]).default("all")
```