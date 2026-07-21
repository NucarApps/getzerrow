# Task 5 — Webhook action (HMAC + SSRF guard + retries)

The `call_webhook` action type is live: when a rule files an email, Zerrow
can POST a signed `email.classified` event to a user-configured HTTPS
endpoint.

## Delivery (`src/lib/webhook/deliver.ts`)

Payload:

```json
{
  "event": "email.classified",
  "email": {
    "id": "…",
    "thread_id": "…",
    "from_addr": "…",
    "from_name": "…",
    "subject": "…",
    "received_at": "…",
    "folder": { "id": "…", "name": "…" },
    "ai_summary": "…"
  },
  "delivery_id": "<scheduled_actions row id>",
  "delivered_at": "…"
}
```

`body_text` is included **only** when the action opted in via
`folder_actions.include_body` (new column); HTML is never sent.

Signing: `X-Zerrow-Signature: sha256=<hex>` = HMAC-SHA256 over
`${timestamp}.${body}` with the action's secret, plus
`X-Zerrow-Timestamp` and `X-Zerrow-Delivery`. Binding the timestamp into
the signature blocks replay. Receivers should compare with a
constant-time equality check. Deliveries are timeboxed (10s), never
follow redirects (`redirect: "error"`), and treat non-2xx as failure.

## SSRF guard (`src/lib/webhook/url-guard.ts`)

Static validation of user-supplied webhook URLs (invariant 4 —
length-bounded + shape-checked): https only, ≤ 2048 chars, no URL
credentials, no `localhost`/`*.localhost`, and IP-literal hosts must not
be loopback, RFC1918, link-local (includes the 169.254.169.254 metadata
endpoint), CGNAT (100.64/10), unspecified, or IPv6
loopback/link-local/unique-local/IPv4-mapped. Applied twice: at enqueue
(dispatcher) and again at send (runner) so config written around the UI
gains nothing. DNS-resolution pinning is out of scope — the fetch runs
from Cloudflare's edge, outside any private perimeter.

## Queue + retries (`src/lib/sync/scheduled-actions.ts`)

Webhooks never run inline in the classify hot path — the dispatcher
always enqueues a `scheduled_actions` row (delayed by `delay_minutes` if
set). A per-minute cron (`run-scheduled-actions-1m` →
`/api/public/hooks/run-scheduled-actions`, CRON_SECRET-gated) claims due
rows via `claim_scheduled_actions` (SKIP LOCKED, 5-minute lease,
`attempt` increments on claim) and executes:

- `call_webhook` — decrypts the secret via the service-role-only
  `get_folder_action_webhook` RPC and delivers.
- the five label-type actions — delayed task-4 actions re-dispatch
  against the email's **fresh** state (idempotent handlers).
- anything else — terminal error until its task lands.

Failures reschedule with backoff `1m → 5m → 15m → 1h → 3h`; attempt 6
fails terminally (`status='error'`, `last_error` kept). Config-gone cases
(action/email deleted, missing URL) fail terminally at once.

## Secrets

`webhook_secret_enc` is encrypted at rest with `EMAIL_ENC_KEY`. The
service-role-only `set_folder_action_webhook` /
`get_folder_action_webhook` RPCs are the only paths that touch the
column (invariant 2). No UI writes webhook configs yet — that arrives
with the actions editor.

## Tests (`src/lib/webhook/webhook-action.test.ts`)

33 cases: the SSRF rejection table (including `169.254.169.254`, `10.*`,
`127.*`, `localhost`, `172.16/12` boundary, IPv6 forms) + acceptance
list, deterministic-signature contract, include_body payload gating,
header/redirect/timeout behavior, and runner retry logic (done /
backoff-reschedule / terminal at attempt 6 / config-gone / delayed
label-action against fresh state).

**Live-fire acceptance:** the sandbox's network policy blocks egress to
webhook.site, so the live test is opt-in:
`RUN_LIVE_WEBHOOK=https://webhook.site/<uuid> npx vitest run
src/lib/webhook/webhook-action.test.ts` from any machine with open
egress (or simply configure a webhook action after deploy and watch the
request arrive signed).
