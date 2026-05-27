## Add type filter to "Always send to inbox" list

In `src/components/settings/InboxOverrides.tsx`, add a filter control above the overrides list so you can narrow it to Email-only or Domain-only entries.

### Changes
- Add `filter` state: `"all" | "email" | "domain"` (default `"all"`).
- Render a shadcn `Tabs` above the list with three triggers: **All**, **Emails**, **Domains**. Each shows a count badge derived from `rows`.
- Filter `rows` by `match_type` before mapping. Empty-state copy adapts ("No email overrides yet." / "No domain overrides yet.").
- Add a small search `Input` next to the tabs that does a case-insensitive substring match on `value`, so long lists are easy to scan. Clears with an `x` button when non-empty.
- No backend changes, no schema changes — purely a UI refinement on the existing query data.

### Out of scope
- The add-form's email/domain `Select` stays as-is.
- Exceptions list inside each row is untouched.