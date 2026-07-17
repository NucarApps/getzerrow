# Tasks feature

A single place for your to-dos — added manually, extracted automatically from meeting transcripts and emails, and checked off (or auto-suggested done) as you send follow-ups.

## Scope (from your answers)
- **Ownership**: only tasks *you* committed to or are asked to do. Action items assigned to others are ignored.
- **Email sources**: incoming requests directed at you + your outgoing commitments ("I'll send it Monday").
- **Completion**: AI scans Sent, flags likely-done tasks with a "looks done — confirm?" chip. You approve or dismiss.
- **UI**: a dedicated `/tasks` page in the nav + inline widgets on the inbox reading pane and the meeting detail view.

## Data model (one migration)

New tables (all RLS-scoped to `auth.uid()`, with grants to `authenticated` + `service_role`):

- `tasks` — `id`, `user_id`, `title`, `notes`, `status` (`open` | `done` | `dismissed`), `due_at`, `source` (`manual` | `meeting` | `email`), `source_meeting_id` (fk `meetings`), `source_email_id` (fk `emails`), `completed_at`, `dismissed_at`, `created_at`, `updated_at`.
- `task_completion_suggestions` — `id`, `task_id`, `sent_email_id` (fk `emails`), `confidence` (`high`/`med`/`low`), `reasoning` (short AI explanation), `status` (`pending` | `confirmed` | `dismissed`), `created_at`. Unique on `(task_id, sent_email_id)` to avoid duplicates.
- `task_extraction_runs` — `id`, `user_id`, `source_type` (`meeting`/`email_in`/`email_out`/`sent_scan`), `source_id`, `ran_at`. Idempotency guard so we don't re-scan the same meeting/email.

## Extraction pipeline

All extraction runs server-side via Lovable AI (`google/gemini-3.5-flash`), never from the client.

1. **Meetings** — new server fn `extractTasksFromMeeting(meetingId)`. Triggered when a meeting transcript finalizes (hook into the existing recording-complete path). Prompt gives the AI the transcript + the user's display name/email and asks only for tasks *the user* took on. Each extracted task inserts a `tasks` row with `source='meeting'`, `source_meeting_id`, and a snippet in `notes`.
2. **Incoming email** — extend the existing per-message classify pass in `src/lib/sync/run-jobs.ts`. After folder classification, if the email is addressed to the user and asks for an action, enqueue a lightweight follow-up job that runs `extractTasksFromEmail(emailId, 'incoming')`. Keeps the hot classify path unchanged.
3. **Outgoing commitments** — a new sent-mail hook (already have Sent processing) runs `extractTasksFromEmail(emailId, 'outgoing')` which looks for first-person commitments and inserts tasks with `source='email'`.
4. **Completion detection** — new cron every 10 min: `scanSentForTaskCompletion` walks recent sent emails, matches against open tasks by recipient + semantic similarity, and writes `task_completion_suggestions` rows (no auto-complete). UI surfaces these as confirm chips.

All AI calls include a JSON-schema `Output` so we get typed results; extraction is skipped if the model returns confidence below a threshold.

## UI

- **`/tasks` route** under `_authenticated/`: filter by status (open/done/dismissed), source (manual/meeting/email), and due date. Each row shows title, source badge with a link ("From meeting: Q3 review" → `/meetings/$id`, "From email: …" → opens inbox drawer), and a checkbox. Confirm-done suggestions render as an amber chip with Accept / Not done buttons.
- **Inline widget on inbox reading pane** (`src/routes/_authenticated/inbox.tsx`): "Open tasks from this thread" list; if the current email spawned a task, show it with a checkbox.
- **Inline widget on meeting detail** (`src/routes/_authenticated/meetings.$id.tsx` or equivalent): "Your action items" list extracted from that meeting, each with a checkbox and link back to the transcript segment.
- **Nav**: add a "Tasks" link with an open-count badge.

## Server functions (new)

Located under `src/lib/tasks/*.functions.ts` + `src/lib/tasks/*.server.ts` helpers, following the same barrel pattern used for `gmail`/`meetings`/`contacts`:

- `listTasks`, `createTask`, `updateTask` (title/notes/due/status), `completeTask`, `dismissTask`, `reopenTask`.
- `extractTasksFromMeeting`, `extractTasksFromEmail` (both authenticated; use `requireSupabaseAuth`).
- `listCompletionSuggestions`, `confirmCompletionSuggestion`, `dismissCompletionSuggestion`.
- `scanSentForTaskCompletion` (called by a public cron route in `src/routes/api/public/tasks-completion-scan.ts` guarded by `CRON_SECRET`).

## Out of scope for v1

- Reminders / push notifications on due dates.
- Assigning tasks to other people or sharing task lists.
- Recurring tasks.
- Calendar-event creation from tasks.

Happy to add any of these as follow-ups once v1 lands.
