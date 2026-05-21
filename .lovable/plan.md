## Change

Default the "Why this folder?" panel on the email detail view to collapsed.

In `src/routes/_authenticated/inbox.tsx` line 670, change `useState(true)` to `useState(false)` for `whyOpen`. The user can still click to expand on demand. No other changes.
