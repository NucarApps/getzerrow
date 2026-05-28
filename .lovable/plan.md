## Make privacy policy claims true (or correct the wording)

Audit found three real gaps and two wording overstatements. This plan fixes what's cheap to fix in code, and softens claims we can't honestly back.

### 1. Fix in code

**a. Revoke Google OAuth on disconnect** — `src/lib/gmail.functions.ts` `disconnectGmailAccount`
- Before deleting the `gmail_accounts` row, fetch the decrypted refresh token and `POST https://oauth2.googleapis.com/revoke?token=<refresh_token>`.
- Best-effort: log failures, don't block the delete — but actually call it. This makes claim #9 true.

**b. Add an account-deletion server function** — new `src/lib/account.functions.ts` with `deleteAccount` (`requireSupabaseAuth`)
- Revoke Google tokens (reuse step a) for each connected Gmail account.
- Delete rows in `gmail_accounts`, `emails`, `folders`, `folder_examples`, `folder_filters`, `reply_drafts`, `inbox_overrides`, `message_jobs`, `contacts`, `cards` for `auth.uid()`.
- Call `supabaseAdmin.auth.admin.deleteUser(userId)` to remove the auth user.
- Wire a "Delete account" button in Settings with a confirm dialog. This makes claim #10 true (and the "within 30 days" line becomes immediate).

### 2. Soften policy wording where code doesn't (yet) match

Edits to `src/routes/privacy.tsx`:

**Claim 2 (encryption at rest)** — replace the current bullet:
> "Synced messages, metadata, summaries, and folder rules are encrypted at rest in our managed database."

with:
> "Synced messages, metadata, summaries, and folder rules are stored in our managed Postgres database with disk-level encryption at rest provided by our infrastructure provider."

(Keeps it honest. We can re-tighten this if/when the planned pgcrypto column encryption lands.)

**Claim 5 (least-privilege)** — replace:
> "...our services run with least-privilege credentials."

with:
> "...server-side database access is gated by authenticated server functions that verify the requesting user before touching their data."

**Claim 7 (AI training)** — replace:
> "No Google user data is used to train generalized or third-party AI models."

with:
> "Email content sent to our AI provider for classification, summarization, and reply drafting is processed under that provider's API data-processing terms, which prohibit using customer API content to train their generalized models. We do not separately train any models on your email content."

### 3. Out of scope (call out, don't do now)

- Actual column-level pgcrypto encryption for email bodies/summaries — this is a bigger migration + read-path change. Tracked as a follow-up; not required to make the policy truthful once #2 wording is softened.

### Files touched

- `src/lib/gmail.functions.ts` (revoke on disconnect)
- `src/lib/account.functions.ts` (new — account deletion)
- `src/routes/_authenticated/settings.tsx` or equivalent (Delete account button + confirm)
- `src/routes/privacy.tsx` (3 wording edits)
