# Make Zerrow inbox auto-update reliably (root cause: case-sensitive email match)

## What's actually broken

Tony's account is stored as `TPercoco@nucar.com`. Gmail's Pub/Sub pushes arrive with the address lower-cased: `tpercoco@nucar.com`. The webhook looks the account up with:

```ts
.eq("email_address", emailAddress)   // case-sensitive in Postgres
```

So every push for him resolves to `accounts_matched = 0` and `synced_count = 0`. Confirmed in the database — the last 10 push events for his mailbox all show 0 accounts matched, 0 synced, despite the gmail_accounts row existing and being healthy (watch valid until June 2, no reconnect needed, no OAuth error).

The poll cron still runs every few minutes, which is why mail eventually shows up — but never in real time. The realtime websocket / `useEmailRealtime` hook itself is fine; there's just nothing being inserted for it to broadcast.

Other users with all-lowercase stored addresses are unaffected, which is why this looks intermittent rather than global.

## Fix

### 1. Make the webhook lookup case-insensitive

In `src/routes/api/public/gmail-webhook.ts` (the `.eq("email_address", emailAddress)` call), switch to a case-insensitive match. Two options; we'll use the first because it's a one-line change with no schema impact:

```ts
.ilike("email_address", emailAddress)   // exact match, case-insensitive
```

(`ilike` without `%` wildcards is an exact case-insensitive equality — same semantics as `=` but folded.)

### 2. Normalize existing rows so the data is clean

One-off migration to lowercase any stored Gmail address that isn't already lowercase:

```sql
UPDATE public.gmail_accounts
   SET email_address = lower(email_address),
       updated_at = now()
 WHERE email_address <> lower(email_address);
```

### 3. Normalize on write going forward

So a future reconnect or new connection can't reintroduce the bug:

- `src/routes/api/public/google-oauth-callback.ts` — lowercase the `email` we get from Google's userinfo before calling `upsert_gmail_oauth_account`.
- Anywhere else we insert/update `gmail_accounts.email_address` (audit `src/lib/gmail.functions.ts`), apply `.toLowerCase()` at the boundary.

### 4. Add a defensive index (optional but cheap)

A functional index keeps `ilike` on an exact value fast even as the table grows:

```sql
CREATE INDEX IF NOT EXISTS gmail_accounts_email_lower_idx
  ON public.gmail_accounts (lower(email_address));
```

### 5. Verify the fix

After deploy:
- Trigger a real send to Tony's mailbox (or wait for the next inbound).
- Check the latest `pubsub_events` rows: expect `accounts_matched = 1`, `synced_count >= 1`.
- Confirm Tony sees the new message appear in Zerrow without refresh.

## Out of scope (intentionally)

- No changes to `useEmailRealtime`, the realtime publication, or replica identity — those are working correctly.
- No changes to the poll / reconcile / cron pipeline.
- No new logging beyond what we added in the recent fidelity pass — the existing structured logs already surface this once we know what to look for; the data-layer fix is what's needed.
