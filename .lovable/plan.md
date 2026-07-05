# Customizable meeting bot

Let users personalize the notetaker bot: its **name**, a **picture** (shown as the bot's video tile in the call), and the **chat message** it posts. One global setup applies to every meeting across all connected inboxes. The message posts when the bot joins and re-posts for late joiners.

## What you'll see

A new **Meeting bot** card in Settings → Meetings, above the auto-record cards, with:
- **Bot name** — text field (default "Zerrow Notetaker").
- **Bot picture** — upload a JPG/PNG; we auto-crop/resize to the format meeting platforms accept and show a preview. Note: Zoom/Meet/Teams have no bot "profile photo", so this image appears as the bot's camera/video tile in the call.
- **Chat message** — the note posted in the meeting chat (default something like "Hi! I'm the Zerrow notetaker recording and summarizing this meeting."). A toggle for "also notify people who join late".
- Save button with success/error toasts.

## How it works

```text
Settings card ──save──> meeting_bot_settings row (name, message, resend flag)
   picture ──upload──> private storage bucket  meeting-bot-avatars/{userId}/avatar.jpg
                                   │
Record / auto-join ──> loadBotConfig(userId) ──> Recall createBot({
   bot_name, chat.on_bot_join, chat.on_participant_join, automatic_video_output(jpeg) })
```

## Technical details

### Database (migration)
- New table `public.meeting_bot_settings`: `user_id uuid unique` (FK auth.users), `bot_name text`, `chat_message text`, `chat_resend_on_join boolean default true`, `avatar_updated_at timestamptz null`, plus `created_at`/`updated_at` with the standard update trigger.
- GRANT SELECT/INSERT/UPDATE/DELETE to `authenticated`, ALL to `service_role`. RLS enabled; single policy `auth.uid() = user_id` for all actions.

### Storage
- Create a **private** bucket `meeting-bot-avatars` (via storage tool).
- RLS policies on `storage.objects` so a user can read/write/delete only files under their own `{userId}/` prefix.
- Client resizes the chosen image to a 1280×720 JPEG (canvas) before upload, keeping it well under the platform 1.3 MB limit. Stored at `{userId}/avatar.jpg`.

### Server functions — `src/lib/meetings.functions.ts`
- `getMeetingBotSettings` (GET, auth): returns the caller's row (or sensible defaults) plus whether an avatar exists.
- `updateMeetingBotSettings` (POST, auth): upserts `bot_name` (≤100 chars), `chat_message` (≤1000 chars), `chat_resend_on_join`. The image is uploaded directly to storage by the client via the browser Supabase client (RLS-scoped); this fn just records `avatar_updated_at` when notified, and supports clearing the avatar.

### Bot config loader — `src/lib/meetings.server.ts`
- New `loadBotConfig(userId)` (uses `supabaseAdmin`): reads the settings row, and if an avatar exists downloads it from the private bucket and base64-encodes it. Returns `{ botName, chatMessage, chatResendOnJoin, imageB64 }` with defaults when no row exists.

### Recall client — `src/lib/recall.server.ts`
- Extend `CreateBotInput` and `createBot` to accept optional `chatMessage`, `chatResendOnJoin`, and `imageB64`, mapping them to Recall's request body:
  - `chat.on_bot_join = { send_to: "everyone", message }` and, when resend is on, `chat.on_participant_join = { exclude_host: false, message }`.
  - `automatic_video_output.in_call_recording` and `in_call_not_recording = { kind: "jpeg", b64_data: imageB64 }` when an image is set.

### Wire into bot creation
- `recordFromLink` (meetings.functions.ts): call `loadBotConfig(context.userId)` and pass name/chat/image into `createBot` instead of the hardcoded `"Zerrow Notetaker"`.
- Auto-join (`src/lib/meetings-autojoin.server.ts`): call `loadBotConfig(account.user_id)` per account and pass the same config into its `createBot`.

### UI — `src/components/settings/MeetingBotCard.tsx` (new)
- shadcn Card with the fields above, React Query for load/save, optimistic-free simple save, image upload → resize → storage upload → `updateMeetingBotSettings`. Rendered in `src/routes/_authenticated/settings.tsx` in the Meetings section (once, above the per-account cards).

## Notes
- No changes to already-scheduled bots; new settings apply to bots created after saving.
- All logic stays server-side; no secrets in the client. Image kept in a private bucket and only ever sent to Recall as base64 from the server.
