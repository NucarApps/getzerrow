# Add meeting recording, transcript & summary (Recall.ai)

Add a new **Meetings** section to Zerrow. Users paste a Zoom/Meet/Teams link (or let Zerrow auto-join meetings from their connected Google Calendar) and a Recall.ai bot joins, records, transcribes, and summarizes. Recordings, transcripts, and summaries are viewable in-app and linked to the matching CRM contacts.

## What the user gets

- A **Meetings** nav item with a list of past/upcoming/in-progress meetings.
- **Paste a link** to send a bot to any live/upcoming meeting.
- **Auto-join** toggle: Zerrow scans upcoming calendar events, finds the meeting URL, and schedules a bot to join at start time.
- A meeting detail view: video/audio playback, full transcript, and Recall-generated summary.
- Meeting summaries surfaced on the related **contact** pages.

## How it works

```text
Paste link  ─┐
             ├─► create Recall bot ─► bot joins & records
Calendar tick┘                              │
                                            ▼
        Recall webhook (status + done) ─► store recording/transcript/summary
                                            │
                                            ▼
            match attendees → link to contacts → show in Meetings + Contacts
```

- **Summary engine: Recall only.** We use Recall's transcription + meeting-intelligence output for both transcript and summary — no Lovable AI in this path.
- Follows existing patterns: push (webhook) + cron reconcile fallback, exactly like the Gmail sync pipeline. All `/api/public/*` mutation endpoints verify a secret, never the publishable key.

## Setup this requires (I'll walk you through in build)

- A **Recall.ai API key** (stored as `RECALL_API_KEY`), the Recall **region** (`RECALL_REGION`), and a **webhook signing secret** (`RECALL_WEBHOOK_SECRET`). Recall isn't a Lovable connector, so this is a custom secret you'll paste.
- One config step in your Recall dashboard: point Recall's webhook at Zerrow's endpoint (I'll give you the exact URL).
- A cron schedule (pg_cron) for the calendar auto-join + reconcile ticks, matching the app's other hooks.

## Scope of changes

### Database (migration)
- `meetings` table: `id`, `user_id`, `gmail_account_id` (nullable), `recall_bot_id`, `title`, `meeting_url`, `platform`, `status` (`scheduled|joining|recording|done|failed`), `scheduled_start`, `started_at`, `ended_at`, `recording_url`, `transcript` (jsonb), `summary` (text), `source` (`link|calendar`), `calendar_event_id` (nullable, for dedupe), timestamps.
- `meeting_participants` table: `meeting_id`, `email`, `name`, `contact_id` (nullable FK to `contacts`).
- RLS scoped to `auth.uid() = user_id`; participants scoped through their meeting. `GRANT` statements for `authenticated` + `service_role` on both tables (service_role for webhook/cron writes).
- `gmail_accounts`: add `auto_record_meetings boolean default false` for the per-account auto-join toggle (reuses existing `calendar_access`).

### Server logic
- `src/lib/recall.server.ts` — Recall REST client (region-aware base URL): `createBot`, `getBot`, `getTranscript`, `getSummary`. Reads `RECALL_API_KEY` inside functions.
- `src/lib/meetings.functions.ts` — `createServerFn` (auth): `recordFromLink`, `listMeetings`, `getMeeting`, `deleteMeeting`, `setAutoRecord`.
- `src/lib/meetings-autojoin.server.ts` — list upcoming calendar events (reuse `calendar.server.ts` + `google-oauth.server.ts`), extract Meet/Zoom/Teams URLs, schedule bots with `join_at`, dedupe on `calendar_event_id`.
- `src/lib/meetings-link.server.ts` — match participant emails to existing `contacts` and populate `contact_id`.

### Public endpoints (`src/routes/api/public/`)
- `recall-webhook.ts` — verifies Recall's Svix signature (`RECALL_WEBHOOK_SECRET`); on status/`done` events updates the meeting, stores recording URL, transcript, summary, and links participants to contacts.
- `hooks/schedule-meeting-bots.ts` — cron tick (CRON_SECRET): auto-join scan for accounts with `auto_record_meetings`.
- `hooks/reconcile-meetings.ts` — cron tick: poll Recall for any non-terminal meetings as a webhook fallback.

### Frontend
- `src/routes/_authenticated/meetings.tsx` — list + "Record a meeting" (paste link) dialog + detail view (playback, transcript, summary). Uses React Query, service layer via server functions.
- Add **Meetings** nav button (Video icon) in `src/routes/_authenticated._authenticated.tsx` sidebar.
- Contact detail (`ContactDetailView.tsx`): a "Meetings" block listing linked meetings/summaries.
- Settings → Accounts: an **Auto-record meetings** toggle per Gmail account (next to the calendar guard card), gated on calendar access.

## Notes / decisions

- Meeting media stays on Recall (we store the URL Recall returns), keeping storage light.
- Transcript stored as jsonb (speaker-segmented) for rendering; summary stored as text from Recall's output.
- If you later want an email digest of summaries, that's a small add on top of this — out of scope for now per your choice of "view in app + attach to contacts".