## Goal

Two changes on the Contacts page:

1. **Clarify and align the Groups rail** — the mysterious gray blocks are contact-count badges; make them readable and line them up.
2. **Add a "From meetings" source when adding contacts** — let you pick people from your past or upcoming Google Calendar meetings who aren't already in Contacts, and add them in one click.

---

## Part 1 — Fix the Groups rail (the gray blocks)

**What they are:** Each group row shows a small pill with the number of contacts in that group (e.g. how many are in "Business"). Today the pill is gray and pill-shaped, so it reads like a toggle switch.

**Why they look misaligned:** Custom groups (Business, Factory, …) render an edit-pencil button that reserves space even while hidden, so their count pills shift left. "All contacts" and "Ungrouped" have no pencil, so their pills sit at the far right.

**Fix (UI only, in `GroupChip`):**
- Give the count badge a clearer, non-toggle look (tabular number, min-width, subtle border) so it reads as a count, not a switch.
- Always reserve the edit-pencil slot width (render an invisible placeholder when there's no `onEdit`), so every count badge lines up in the same column across all rows.
- Tooltip on the badge: "Contacts in this group".

No data or behavior changes here — purely presentation in `src/routes/_authenticated/contacts.index.tsx`.

---

## Part 2 — Add contacts from calendar meetings

Add a third tab, **From meetings**, to the existing "Add contacts" dialog (alongside Manual and From inbox).

**Behavior:**
- A Past / Upcoming toggle (default Past) plus a search box.
- Lists people who appear as attendees/organizers on your meetings but are **not already in Contacts** and aren't your own address.
- Each row shows name (when Google provides it), email, the meeting date, and a sample event title. Multi-select with "select all visible", then "Add N contacts".
- Adding reuses the existing bulk-add path so new people land in Contacts immediately.
- If no connected account has calendar access, the tab shows a short prompt pointing to Settings to enable the Calendar guard / grant access.

**Defaults:** Past = last 12 months (matches the existing guard window); Upcoming = next 3 months. Results aggregate across all your calendar-enabled accounts, deduped by email.

---

## Technical notes

**`src/lib/calendar.server.ts`** — add a name-aware, date-aware reader:
- Extend the event parser to also capture each attendee's `displayName` and the event's start time + summary (keep the existing `extractAttendeeEmails` pure helper intact for the guard).
- Add `listCalendarPeople(accountId, { when: "past" | "upcoming" })` that pages Google Calendar (`timeMin`/`timeMax` set by direction, `singleEvents=true`, capped pages like the existing sync) and returns `{ email, name, meetingAt, eventTitle }[]`, owner + resource calendars excluded. Reuse `calendarFetch` and the existing `CalendarApiError` handling so auth/api-disabled/rate-limit states surface correctly.

**`src/lib/calendar.functions.ts`** — new server fn `listMeetingPeople`:
- `createServerFn({ method: "POST" })` + `requireSupabaseAuth`, input `{ when: "past" | "upcoming", search?: string }` (Zod-validated).
- Resolve the user's `gmail_accounts` with `calendar_access = true` (via `supabaseAdmin`, scoped to `userId`).
- For each, call `listCalendarPeople`; merge results, lowercase/dedupe by email, keep the most relevant meeting date and a sample title.
- Exclude addresses already in `contacts` for this user; apply the optional search filter; sort (past: most recent first; upcoming: soonest first); cap the list.
- Return `{ people, calendarAccess: boolean }` so the UI can show the no-access prompt. Per-account Google errors are caught and skipped (logged) so one bad account doesn't break the list.

**`src/routes/_authenticated/contacts.index.tsx`** — extend `AddContactsDialog`:
- Add the "From meetings" tab with the Past/Upcoming toggle, search, multi-select list (mirrors the existing "From inbox" tab structure and selection state).
- `useQuery` on `listMeetingPeople` keyed by `{ when, search }`, enabled only when the tab is open.
- Reuse the existing `bulkCreateContactsFromEmails` call and `onAdded` invalidation.

**Reused / unchanged:** `bulkCreateContactsFromEmails`, `listContacts`, the calendar OAuth/token helpers, and the guard's `syncCalendarContacts` are untouched. No DB migration needed — meeting people are fetched on demand from Google, not persisted.

**Tests:** extend `src/lib/calendar-extract.test.ts` to cover the new name/date extraction (displayName captured, owner/resource excluded, start time + summary surfaced).
