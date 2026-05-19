# Zerrow — Build Plan

A single-tenant AI inbox connected to your Gmail account. Emails arrive via Gmail push, the AI categorizes them into your folders, summarizes them, can auto-archive/mark-read per folder rules, and can suggest replies on demand.

## Scope

- **Account model**: One Gmail account (yours), connected via the Lovable Gmail connector.
- **Real-time**: Gmail Pub/Sub push → webhook → DB update → live UI.
- **Folders**: Custom folders, each backed by a Gmail label (so categorization syncs back to Gmail).
- **Rules per folder**: Structured filters (from, to, subject contains, has-attachment, etc.) + a natural-language rule the AI uses.
- **AI actions**: Categorize, one-line summary, on-demand reply drafts, per-folder auto-archive / mark-as-read.

## Architecture

```text
Gmail ──push──> Google Pub/Sub ──HTTPS──> /api/public/gmail-webhook
                                                │
                                                ▼
                                  Fetch new messages via Gmail API
                                                │
                                                ▼
                            Apply structured filters → match folder
                                                │
                                                ▼
                          AI: classify (if filters tie/none) + summarize
                                                │
                                                ▼
                       Persist email + apply Gmail label + auto-actions
                                                │
                                                ▼
                       Supabase Realtime → UI updates instantly
```

## Stack

- **Frontend**: TanStack Start, Tailwind, shadcn.
- **Backend**: TanStack server functions + a public webhook route at `/api/public/gmail-webhook`.
- **Gmail**: Lovable Gmail connector (gateway) — needs `gmail.readonly`, `gmail.modify`, `gmail.compose`, `gmail.labels`.
- **AI**: Lovable AI Gateway, `google/gemini-3-flash-preview` for classify+summarize, structured output via AI SDK.
- **DB / Realtime / Auth**: Lovable Cloud (Supabase). Email/password login so only you (and people you allow) can view the inbox.

## Data model

- `folders` — id, name, color, gmail_label_id, ai_rule (text), auto_archive (bool), auto_mark_read (bool), priority (int).
- `folder_filters` — id, folder_id, field (from|to|subject|body|has_attachment|domain), op (contains|equals|regex), value.
- `emails` — id, gmail_message_id (unique), thread_id, from, to, subject, snippet, body_html, received_at, is_read, is_archived, folder_id, ai_summary, ai_confidence, raw_labels[].
- `sync_state` — single row: last_history_id, watch_expiration.
- `reply_drafts` — id, email_id, draft_text, created_at.

RLS: all tables locked to authenticated users.

## Real-time push (one-time setup you'll do)

Gmail push needs a Google Cloud Pub/Sub topic; the connector can't create it. After connecting Gmail, I'll give you a short walkthrough:

1. In Google Cloud Console, create a Pub/Sub topic `zerrow-gmail` and grant `gmail-api-push@system.gserviceaccount.com` Publisher.
2. Create a push subscription pointing to `https://<your-project>.lovable.app/api/public/gmail-webhook` with a shared secret token in the URL.
3. I'll add a "Start watching inbox" button that calls `users.watch` with that topic; renews every ~6 days via cron.

Until that's wired, polling every 60s acts as a fallback so the app still works.

## Pages

- `/login` — email/password.
- `/` — inbox: folder sidebar, email list, reading pane, AI summary chip, "Suggest reply" button.
- `/folders` — create/edit folders, structured filters, AI rule, auto-actions toggles.
- `/settings` — connect Gmail, start/stop watch, view sync status.

## Build order

1. Enable Lovable Cloud, auth, schema + RLS.
2. Connect Gmail connector; initial backfill of last N messages.
3. Folders + filters UI and CRUD.
4. Classification pipeline (filters first, AI fallback) + summarization; apply Gmail labels and auto-actions.
5. Inbox UI with Supabase Realtime subscription.
6. Reply suggestion server fn (Lovable AI).
7. `/api/public/gmail-webhook` with shared-secret verification + history sync; polling fallback cron.
8. Pub/Sub setup walkthrough + watch renewal cron.

## Notes / trade-offs

- Single-account: anyone who logs in sees the same inbox — keep auth tight.
- Permanent delete isn't supported by the Gmail connector; "Delete" will trash instead.
- AI cost scales with inbox volume — filters run first so the model only sees ambiguous mail.

Approve to start with step 1 (Cloud + auth + schema) and the Gmail connection.
