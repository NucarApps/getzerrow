## Why the last run only moved 7 contacts

DB confirms the migration ran and forced 447 stale rows. Since then one sync completed and only pushed 7 contacts before the 18 s wall-clock budget cut the loop off; the remaining 440 are still at `last_synced_at = epoch`, and the 33 unlinked Zerrow contacts (489 vs 456) haven't been created in Google yet. `pushGroupMemberships` — which is where the `myContacts` promotion I added lives — sits at the end of `pushToGoogle`, so on a large backlog it's budget-starved and never runs. That's why Google's Contacts count barely moved (388) and subgroup labels still haven't been renamed to `Parent - Child`.

At the current drain rate (7 / 5 min) it would take ~5 hours to catch up. The pipeline works, it's just throttled far too hard for a first-time push of ~450 rows.

## Changes

### 1. Raise per-run throughput
`src/lib/google-contacts/push.server.ts`
- Bump `PUSH_WALL_BUDGET_MS` from 18 s to 55 s. The cron endpoint runs in a Cloudflare Worker HTTP handler (default 30 s subrequest cap per outgoing fetch, but overall wall much longer for scheduled/http); 55 s leaves room for pull + finalize inside a ~90 s ceiling.
- Bump `MAX_CONTACTS_PER_RUN` from 200 to 500 so the selection isn't the cap on backlog days.
- Push contacts in parallel chunks of 5 (`Promise.all` inside the loop) instead of one-at-a-time. Each People API call is ~200-400 ms; serial `for` under-uses the request budget.
- Keep per-iteration wall check so we still break cleanly on the 55 s boundary.

### 2. Move `myContacts` promotion out of the starved tail
`src/lib/google-contacts/push.server.ts` (`pushToGoogle`)
- Extract the myContacts-only reconcile from `pushGroupMemberships` into its own `promoteToMyContacts(ids)` step and call it **before** the per-contact loop, so it always runs even when the loop later hits the budget. It's a single `members:modify` request per run.
- Keep the label-membership reconcile in `pushGroupMemberships` for real user labels (Factory, Vendor, etc.) as-is.

### 3. Force one large drain pass now
- Migration re-arms `google_contact_links.last_synced_at = epoch` for any row still stale (idempotent), and marks the 33 unlinked contacts' `updated_at = now()` so they surface into the dirty scan. Once #1 and #2 ship, the next 3-4 cron ticks (every 5 min) should fully close the 489-vs-388 gap and rename all subgroups to `Parent - Child`.

### 4. Surface backlog explicitly in the Admin dashboard
`src/routes/_authenticated/admin.tsx` + a small server fn in `src/lib/google-contacts.functions.ts`
- Add a "Google Contacts backlog" card showing per-account: pending body, pending photo, unlinked-to-Google count, and last drain size, so you can watch the number tick down in real time instead of guessing from Google's UI.

### 5. Test the new throughput math
`src/lib/google-contacts/push.test.ts`
- Unit test for a `chunk(array, size)` helper (extracted for the parallel loop).
- Unit test that the extracted `computeMyContactsAdditions(desiredResourceNames, remoteMemberResourceNames)` returns only the diff (already covered by `calculateMembershipDelta`; add a case asserting we never remove).

## Out of scope
- Any change to CardDAV / iOS behavior.
- Changing the cron cadence (5 min already correct; the fix is per-run throughput).
- Structural rewrite of `pushContacts` — only the loop shape changes.

## Follow-up if this doesn't close the gap
If after ~30 minutes the backlog is still large, the next lever is running the push in a background `waitUntil` after the HTTP response is sent, so the Worker can use its full CPU budget without a client-visible wait. I'll suggest that only if we see the 55 s budget still getting hit.
