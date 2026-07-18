## Goal

When Zerrow generates a relationship summary for a contact, include that
summary at the top of the NOTE field synced to iOS (and Google) so it shows
up in the notes area of the contact card on the iPhone.

## How it will work

The AI summary lives in `contacts.relationship_summary` (encrypted). The
user's own notes live in `contacts.notes`. iOS only shows one Notes field on
a contact, so we merge the two when we build the vCard and split them apart
again when iOS sends changes back.

Merged NOTE shape sent to iOS:

```text
🤖 Zerrow summary
{relationship_summary text}

— My notes —
{user notes text}
```

Rules:
- If there is no AI summary, the NOTE is just the user's notes (today's behavior).
- If there is no user note, only the summary block is sent.
- Order is fixed (summary on top) so it's always in the same place on the phone.

## Round-trip safety

When iOS PUTs the contact back, `handlePut` currently writes the whole NOTE
into `contacts.notes`. That would swallow the AI summary into the user
notes column and cause it to keep appending on the next sync.

Fix: before writing to `notes`, strip the leading `🤖 Zerrow summary … —
My notes —` block using a marker. Only the trailing user portion is saved
to `contacts.notes`. If the user edits the summary block itself on their
phone, those edits are ignored (the summary column stays as the source of
truth for AI text). This keeps behavior deterministic and matches how
Google Contacts handles it too, since we reuse the same vCard/patch path.

## User control

Add a toggle in **Settings → iPhone contacts** (`settings.carddav.tsx`):
"Include Zerrow's relationship summary in iPhone notes" — default ON.

Stored on `public.carddav_settings` as a new `include_summary_in_notes`
boolean column. Bumps `resync_nonce` when toggled so iPhone re-pulls
without re-adding the account.

Google Contacts sync (`push.server.ts`, `contactToPerson`) uses the same
merged NOTE so the summary shows up in Google Contacts too, respecting the
same toggle.

## Files to change

- `supabase/migrations/*` — add `include_summary_in_notes boolean not null default true` to `public.carddav_settings`.
- `src/lib/carddav/vcard.ts` — add a `buildMergedNote(summary, notes)` helper and a `stripSummaryFromNote(text)` inverse; use them in `contactToVCard` and expose them for parse callers.
- `src/lib/carddav/handlers.server.ts` — pass `relationship_summary` + setting into `contactToVCard`; in `handlePut` run `stripSummaryFromNote` before persisting `notes`.
- `src/lib/carddav/settings.functions.ts` — surface `include_summary_in_notes` in `get`/`update`.
- `src/routes/_authenticated/settings.carddav.tsx` — add the toggle UI.
- `src/lib/google-contacts/mapper.ts` (`contactToPerson`) — feed the merged NOTE into `biographies[0].value`, and strip on inbound too so pulls don't duplicate.
- `src/lib/carddav/merge.test.ts` + `src/lib/carddav/sync.regression.test.ts` — add cases: summary+notes builds correctly; iOS PUT of merged NOTE saves only user notes; empty user notes stays empty after PUT.

## Not doing

- No new AI generation — this feature only surfaces the summary that
  already gets generated during enrichment.
- No edit-summary-from-iPhone flow — the summary block on iOS is
  read-only; edits there are discarded when we split the NOTE.
