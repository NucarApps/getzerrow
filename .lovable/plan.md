## What's happening

The message in your screenshot ("Manheim" via Old User Ken Connor) is stored with:

- `from_addr = kconnor@nucar.com`
- `list_id = <kconnor.nucar.com>` (a Google Group / relay)
- `reply_to_addr = null`, `origin_addr = null`, `is_forwarded = false`

So the forwarder-aware code we added is working end to end — the filter drawer shows `kconnor@nucar.com` simply because no original sender was recovered for this message. Across the last 7 days only 2 of 4,974 messages got an origin sender, so the header precedence is missing the shape Google uses for these relayed/group messages.

Most likely cause (not yet confirmed): Gmail rewrites `From` for DMARC on group/relayed mail and puts the real sender in `X-Google-Original-From`, a header our precedence list doesn't check. Step 1 verifies this against the real message before we change logic.

## Plan

1. **Confirm the headers.** Add a temporary admin-only server function that fetches one Gmail message by ID (`format=full`) and returns only header names/values for the message in question, so we can see exactly which header carries "Manheim". No content is logged or stored.

2. **Extend origin-sender precedence** in `src/lib/gmail/origin-sender.ts` based on what step 1 shows. Expected additions:
   - `X-Google-Original-From` (Gmail's DMARC rewrite) at the top of the list.
   - Google Groups relay detection: when `List-Id` is present and `From` display name ends in "… via …", treat the message as forwarded and take the origin from the group headers (`X-Original-Sender`, `X-Google-Original-From`, `Sender`).
   - Last-resort fallback: when a message is clearly relayed (List-Id present, display name contains "via") but no header names an address, still mark `is_forwarded = true` and keep the recovered display name so the UI can say "via Old User Ken Connor" instead of silently pretending Ken sent it.
   - New unit tests covering the exact Manheim/Nucar header shape plus the existing cases (no regressions to same-domain Reply-To handling).

3. **Backfill existing mail.** Add a bounded, resumable admin action that refetches recent messages from Gmail (chunked, respecting the existing wall-clock budget and rate-limit handling) and updates only `reply_to_addr`, `origin_addr`, `is_forwarded` on rows where `origin_addr is null`. Default scope: last 90 days, run in batches with progress shown in the admin view. No reclassification is triggered by the backfill.

4. **Filter drawer polish.** With origin recovered, "Filter messages like this" already defaults to the original sender. Improve the case where the origin is only known by name: show the forwarder explicitly and label the toggle "Match original sender (Manheim)" vs "Match forwarder (kconnor@nucar.com)", and keep the existing-match count in sync with whichever option is selected.

## Technical notes

- Files touched: `src/lib/gmail/origin-sender.ts` (+ tests), `src/lib/gmail.server.ts` (pass `list-id`-aware context into the derivation), a new backfill module under `src/lib/sync/`, the admin route for triggering it, and `src/components/emails/FilterLikeThisDrawer.tsx`.
- No schema changes: `reply_to_addr`, `origin_addr`, `is_forwarded` already exist on `emails`, and the encrypted upsert RPC already writes them.
- The temporary header-inspection function is removed once the precedence fix is verified.
