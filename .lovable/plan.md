## Reports page — inbox stats & top domains

Add a new authenticated route `/reports` linked in the sidebar right under Inbox. It surfaces fun, glanceable stats computed from the `emails` table for the current user.

### Route
- New file: `src/routes/_authenticated/reports.tsx` (protected by existing `_authenticated` layout).
- Sidebar entry in `src/routes/_authenticated.tsx`, directly under the Inbox button, using a `BarChart3` Lucide icon. Active-state styling matches existing buttons.

### Data
- Single server fn `getInboxReport` in `src/lib/reports.functions.ts` using `requireSupabaseAuth`.
- Pulls last 90 days of emails (`from_addr`, `received_at`, `folder_id`, `is_read`, `has_attachment`, `raw_labels`) for the user, capped to a sensible row limit (e.g. 20k).
- Computes server-side:
  - Total received (90d / 30d / 7d)
  - Average emails per day (last 30d)
  - Busiest day of week + busiest hour of day (histograms)
  - Top 10 sender domains (parsed from `from_addr`) with counts + % share
  - Top 10 individual senders
  - Read vs unread split
  - % with attachments
  - Per-folder breakdown (join `folders` for name + color)
  - 30-day sparkline of daily volume

### UI
- Header: "Inbox Report" + subhead "Last 90 days".
- Stat cards row: total, avg/day, busiest day, busiest hour, unread %, attachment %.
- Two-column section:
  - Top domains list (bar-style rows with count + share).
  - Top senders list (same treatment).
- Daily volume sparkline (simple inline SVG, no new deps).
- Folder breakdown bars using folder color.
- Empty state when zero emails.
- Uses existing semantic tokens; no new colors. Loading via TanStack Query + skeletons matching existing pages.

### Out of scope
- No date range picker (fixed 90d window v1).
- No CSV export.
- No per-day filtering / drill-through.
- No new tables or migrations.
