# Rules-engine upgrade — migration order & rollout notes

How to bring an older getzerrow deployment up to the 2026-07 rules-engine
upgrade (tasks 1–13, PRs #70–#86). Everything is **additive**: no columns
or files were renamed or deleted, legacy folder flags keep working as
implicit actions, and existing migrations were never edited.

## Prerequisites (already true on any working deployment)

- `pg_cron` + the `private.cron_post(path)` helper configured to POST to
  your worker with the `CRON_SECRET` bearer.
- `EMAIL_ENC_KEY` set as a worker secret (pgcrypto encryption).
- `LOVABLE_API_KEY` set (AI classification already uses it).

**No new environment variables are introduced by the upgrade.** The only
new _test-time_ variable is `RUN_LIVE_WEBHOOK=<url>` for the opt-in
live-fire webhook delivery test.

## Migration order

Apply in timestamp order (this is exactly what `supabase migration up`
does). Code-only tasks (2, 3, 10, 11) have no migration.

| #   | File                                              | Task | Adds                                                                                                                                 |
| --- | ------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `20260721210000_executed_rules_audit_log.sql`     | 1    | `executed_rules` + `executed_actions` (audit log; encrypted reason; read-own RLS; service-role write RPCs)                           |
| 2   | `20260721230000_folder_actions_and_scheduled.sql` | 4    | `folder_actions` + `scheduled_actions` (action rows, delayed queue; owner RLS)                                                       |
| 3   | `20260722001000_webhook_action_delivery.sql`      | 5    | webhook columns/RPCs, `claim_scheduled_actions`, **cron** `run-scheduled-actions-1m` (`* * * * *`)                                   |
| 4   | `20260722003000_folders_run_on_threads.sql`       | 6    | `folders.run_on_threads`                                                                                                             |
| 5   | `20260722010737_contact_groups_kind.sql`          | 7    | `contact_groups.kind`, **cron** `categorize-senders-nightly` (`17 3 * * *` UTC)                                                      |
| 6   | `20260722030000_outbound_action_templates.sql`    | 8    | `set_folder_action_template` / `get_folder_action_outbound` RPCs (encrypted templates, service-role only)                            |
| 7   | `20260722040000_digest_action.sql`                | 9    | `digest_items`, `user_settings`, **cron** `send-digest-hourly` (`7 * * * *`)                                                         |
| 8   | `20260722060000_classification_feedback.sql`      | 12   | `classification_feedback` (owner RLS)                                                                                                |
| 9   | `20260722080000_rules_ops_retention.sql`          | 13   | `cleanup_old_scheduled_actions` + `cleanup_old_digest_items` RPCs (picked up by the existing daily retention cron — no new schedule) |

> **Duplicate-file caveat:** the repo also carries
> `20260721183630_cdaeab8d-….sql`, Lovable's re-record of migration #1 as
> it was applied to production. The two create identical objects. A
> database that already ran one must not run the other; on a **fresh**
> replay, skip one of the two (see `casa-readiness.md` §3).

All crons POST through `private.cron_post`, so they inherit your existing
`CRON_SECRET` auth — the endpoints fail closed (401) without it. Each
migration reschedules its cron idempotently (unschedule-first), so
re-running an applied file's cron block is safe.

## Feature activation checklist

The upgrade ships **no feature flags** — features turn on by data and
per-folder configuration, and everything is inert until configured:

- [ ] **Audit trail & explanations** — on automatically after migration
      #1; view at Settings → Rule activity.
- [ ] **Filter-tree rules** — folders with a `filter_tree` route
      deterministically; existing AI-rule folders are untouched.
- [ ] **Explicit actions** — insert `folder_actions` rows (owner-RLS'd, so
      the app's authenticated client or service tooling can write them —
      there is no folder-editor UI for action rows yet; legacy flags remain
      the UI-exposed path and keep working with no action needed).
- [ ] **Webhooks** — per-action URL (+ optional signing secret via the
      task-5 RPC) required; bodies excluded unless `include_body` is set.
- [ ] **Reply/draft/send templates** — store via the service-role
      `set_folder_action_template` RPC (encrypted at rest; no UI yet);
      a template-less `reply` action falls back to a timeboxed AI draft.
- [ ] **Thread scope** — off per folder until `run_on_threads` is enabled.
- [ ] **Sender categories** — nightly cron populates `ai_category` groups
      automatically; rules opt in via `sender_in_group`.
- [ ] **Digests** — add a `digest` action to a folder; delivery time
      defaults to 08:00 UTC daily until the user sets
      `user_settings.digest_hour` / `digest_timezone` / `digest_weekly_dow`.
- [ ] **Simulator / Rule-from-email / feedback** — UI features, live as
      soon as the code deploys; no configuration.

## Post-upgrade verification

1. `bun run test && bunx tsc --noEmit && bun run lint` — the suite covers
   every feature above (96 files as of task 13).
2. Fail-closed sweep against the deployed URL:
   `PUBLIC_BASE_URL=https://<your-app> bun run test:integration`
   (expects 401 from all 27 cron endpoints without the secret).
3. Optional live webhook delivery:
   `RUN_LIVE_WEBHOOK=<https-endpoint> bunx vitest run src/lib/webhook/webhook-action.test.ts`.
4. Watch `pubsub_events` for the new run rows (`scheduled_actions_run`,
   `categorize_senders_run`, `send_digest_run`, and the extended daily
   `retention` row).

## Build footprint

Verified at task 14: `bun run build` produces a clean Cloudflare Workers
bundle. Pre-upgrade baseline (`52d853e`, before PR #70) vs post-upgrade
(`3c3e8e8`, PR #86): total `.output` 9.10 MB → 9.27 MB (**+1.9 %**),
server 6.82 MB → 6.93 MB (+1.6 %), client 2.28 MB → 2.33 MB (+2.2 %) —
well inside the ≤ 15 % acceptance bound.
