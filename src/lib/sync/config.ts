// Centralized sync configuration. Magic numbers used to live next to
// the code that consumed them (poll's silence threshold, account-
// context cache TTL, forward-lock window, backfill page sizes, etc).
// Collecting them here makes operator-visible behavior knobs
// discoverable in one place, and makes it obvious which values are
// safe to tweak vs. baked into protocol assumptions.
//
// Naming convention: `<DOMAIN>_<WHAT>_<UNIT>`. Defaults are what the
// app ships with; override only when you've thought about it.

// ─── Account context cache ───────────────────────────────────────────────

/** How long the per-account (folders + filters + overrides) blob stays
 * cached before refetching. Short TTL so a mutation propagates within
 * a few seconds even when an explicit invalidateAccountContext call is
 * missed. */
export const ACCOUNT_CONTEXT_TTL_MS = 5_000;

// ─── Backfill ────────────────────────────────────────────────────────────

/** Pages per cron tick for the deep-backfill ticker. 20 × 100 = 2000
 * Gmail message IDs collected per tick. */
export const BACKFILL_LIST_PAGES_PER_TICK = 20;

/** maxResults per Gmail listMessages call during backfill paging. */
export const BACKFILL_PAGE_SIZE = 100;

/** Hard cap on bootstrap-bootstrap-anchored history catch-up. Anything
 * older falls to the deep-backfill job rather than blocking the
 * sync-since-history hot path. */
export const BOOTSTRAP_MAX_MESSAGES = 2000;

// ─── Poll cron ───────────────────────────────────────────────────────────

/** Per-account threshold for "push has gone silent → re-arm watch".
 * Looked up against gmail_accounts.last_push_at; lower = quicker
 * recovery from a broken watch, higher = fewer false positives on
 * quiet mailboxes. */
export const POLL_PER_ACCOUNT_SILENCE_MS = 2 * 60 * 60 * 1000; // 2h

/** Cooldown after an auto re-arm before we'll re-arm the same account
 * again. Stops a broken Pub/Sub topic from causing a re-arm loop. */
export const REARM_COOLDOWN_MS = 30 * 60 * 1000; // 30min

// ─── Webhook ─────────────────────────────────────────────────────────────

/** Time budget for the inline post-webhook drain. Pub/Sub considers a
 * push delivered if we ack within ~10s. The webhook drains with
 * `deferAiToCron` so it only inserts rows (fires realtime instantly) and
 * hands the AI classification step off to the 5s live cron — that keeps
 * the ack well under the deadline, so the budget only needs to cover a
 * couple of insert rounds. */
export const WEBHOOK_INLINE_DRAIN_BUDGET_MS = 4_000;

/** When the webhook drain defers a message's AI step to the cron, the
 * job is requeued this far in the future. MUST exceed
 * WEBHOOK_INLINE_DRAIN_BUDGET_MS — otherwise the webhook's own remaining
 * drain rounds re-claim the deferred job and re-fetch the message from
 * Gmail a third time. Still short enough that the next
 * `gmail-process-live-5s` cron tick finishes the AI pass within seconds. */
export const WEBHOOK_DEFERRED_AI_REQUEUE_MS = 5_000;

// ─── History sync ────────────────────────────────────────────────────────

/** Parallelism for the labelsAdded metadata fetches in syncSinceHistory.
 * Each fetch is ~200ms against the Gmail API; sequential fetching made a
 * push with N label events cost N×200ms. */
export const HISTORY_LABEL_FETCH_CONCURRENCY = 5;

// ─── AI classification budgets ───────────────────────────────────────────

/** Per-model-attempt timeout inside classifyEmail's fallback cascade.
 * Without this a slow first attempt eats the whole 25s job budget.
 * Lowered to 5s so a stalled model attempt fails over to the next one
 * faster (speed-first tuning). */
export const AI_CLASSIFY_ATTEMPT_TIMEOUT_MS = 5_000;

/** Total wall-clock budget across ALL cascade attempts. Must stay under
 * the queue's 25s JOB_TIMEOUT_MS with headroom for fetch + DB writes. */
export const AI_CLASSIFY_TOTAL_BUDGET_MS = 18_000;

/** Per-attempt timeout for the batched backfill classifier (bigger
 * prompts, only 2 attempts). */
export const AI_BATCH_ATTEMPT_TIMEOUT_MS = 12_000;

// ─── Worker concurrency ──────────────────────────────────────────────────

/** Default worker-pool size for runMessageJobs. Each worker processes one
 * message at a time (Gmail fetch + classify + DB writes); 32 keeps a
 * limit=100 batch draining quickly while staying inside the Worker's
 * subrequest ceiling. */
export const JOB_WORKER_CONCURRENCY = 32;

/** When a single live (priority<10) claim batch contains at least this
 * many AI-eligible messages, the live lane routes their AI step through
 * the batched classifier (8/call) instead of N inline calls. Below the
 * threshold, live mail keeps its inline, instant-folder behavior. */
export const LIVE_BATCH_AI_THRESHOLD = 12;

// ─── Synchronous catch-up sync ───────────────────────────────────────────

/** When the user opens the app after time away, triggerSync processes
 * up to this many newly-enqueued messages SYNCHRONOUSLY before
 * returning, so the client's refetch lands all the new mail in one go
 * (no row-by-row trickle). Anything beyond this falls back to the
 * regular live-cron lane. Tuned conservatively because triggerSync
 * already does backfillRecent + reconcile and Safari drops requests
 * that run too long. */
export const CATCHUP_BULK_LIMIT = 30;

/** Parallelism for the bulk Gmail getMessage(format=full) fetch inside
 * the catch-up path. Gmail tolerates ~10-20 concurrent reads per user
 * comfortably. */
export const CATCHUP_FETCH_CONCURRENCY = 20;

/** Max number of consecutive bulkCatchupClaim rounds a single sync will
 * run. After a long absence the queue can hold far more than
 * CATCHUP_BULK_LIMIT; looping a few rounds drains most of it in one sync
 * so new mail lands at once instead of trickling via the cron lane.
 * Bounded so a huge backlog can't run forever. */
export const CATCHUP_MAX_ROUNDS = 6;

/** Wall-clock budget across all catch-up rounds in a single sync. Stops
 * the loop before the browser drops a long-running request (Safari
 * surfaces this as "Load failed"); the remainder falls back to the cron
 * lane / background tick. */
export const CATCHUP_TOTAL_BUDGET_MS = 12_000;

/** How often the open inbox runs a silent background sync (history pull +
 * bounded catch-up drain) so it stays current without a manual refresh or
 * page reload. Paused while the tab is hidden. */
export const BACKGROUND_SYNC_INTERVAL_MS = 30_000;

// ─── Stranded-email rescue sweep ─────────────────────────────────────────

/** Only rescue emails that arrived within this window. Older mail is
 * presumed deliberately left in Inbox. */
export const RESCUE_WINDOW_HOURS = 48;

/** Per-email cap on rescue attempts. After this the email stays as
 * classified_by='unclassified' (visible in Inbox — correct failure mode). */
export const RESCUE_MAX_ATTEMPTS = 3;

/** Max emails per sweep tick. */
export const RESCUE_BATCH_LIMIT = 50;

/** Emails per batched LLM call inside the rescue sweep. */
export const RESCUE_AI_BATCH_SIZE = 8;

// ─── Watch renewal ───────────────────────────────────────────────────────

/** Watch renewal cron runs every 6h and renews any watch expiring
 * within this window. 72h means a missed renewal cron is absorbed
 * without watches lapsing. */
export const WATCH_RENEW_WINDOW_HOURS = 72;

/** Operator alert threshold — after a renewal pass, any account still
 * expiring within this window gets a watch_renew_failed event logged
 * to pubsub_events. */
export const WATCH_NEAR_EXPIRY_ALERT_HOURS = 24;

// ─── Forward retry ───────────────────────────────────────────────────────

/** Max attempts for an auto-forward before we park the row and require
 * operator action. */
export const FORWARD_MAX_ATTEMPTS = 5;

/** Backoff schedule for forward retries. Wider spread than the
 * message-job backoff because forward failures are usually slow to
 * clear (recipient mailbox down, downstream rate limit, etc). */
export const FORWARD_BACKOFF_SECONDS = [60, 300, 1800, 7200, 21600]; // 1m, 5m, 30m, 2h, 6h

// ─── Message classification ──────────────────────────────────────────────

/** Gmail system labels that disqualify a message from being ingested as a
 * user-facing inbox email (sent/draft/trash/spam/chat). */
export const EXCLUDED_LABELS = ["SENT", "DRAFT", "TRASH", "SPAM", "CHAT"];

// ─── Reconcile ───────────────────────────────────────────────────────────

/** Default per-tick reconcile window. Operator can override per-call
 * via the cron endpoint's `?limit=` param. */
export const RECONCILE_DEFAULT_LIMIT = 200;

/** Bumped window when an account looks "suspect" (recent push event
 * had an error, or last_history_sync_at is over 30 min old). */
export const RECONCILE_SUSPECT_LIMIT = 500;

// ─── Latency tile SLO ────────────────────────────────────────────────────

/** Push → ack and push → visible latencies under this are green. */
export const LATENCY_GOOD_MS = 1_000;
/** Between LATENCY_GOOD_MS and this: amber. Above: red. */
export const LATENCY_WARN_MS = 3_000;

// ─── Staleness badge thresholds ──────────────────────────────────────────

/** Threshold below which the staleness badge is green ("live"). */
export const STALENESS_LIVE_HOURS = 1;
/** Between LIVE and this: amber. Above: red. */
export const STALENESS_AMBER_HOURS = 6;

// ─── Retention defaults ──────────────────────────────────────────────────

/** pubsub_events retention for normal rows. Error rows kept longer
 * (PUBSUB_KEEP_ERRORS_DAYS) for forensics. */
export const PUBSUB_KEEP_DAYS = 30;
export const PUBSUB_KEEP_ERRORS_DAYS = 60;

/** DLQ retention. Truly-dead jobs eventually purge. */
export const DLQ_KEEP_DAYS = 30;

/** Decryption audit log retention. */
export const AUDIT_KEEP_DAYS = 90;
