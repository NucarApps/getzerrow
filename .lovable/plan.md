Split the Settings page into shadcn `Tabs` so each section gets its own tab.

## Tabs

- **Accounts** — the existing "Connected Gmail accounts" card.
- **Inbox filters** — the `<InboxOverrides />` card (emails & domains always routed to inbox / filtered).
- **Activity** — `<PubsubActivity />` + `<ProcessingJobs />` (kept together since both are diagnostic).

Default tab: **Accounts**.

## Implementation

Edit `src/routes/_authenticated/settings.tsx`:

- Import `Tabs, TabsList, TabsTrigger, TabsContent` from `@/components/ui/tabs`.
- Keep the page header (`<h1>Settings</h1>`) above the tab bar.
- Wrap the three groupings in `<TabsContent value="...">`. No logic changes inside any of the existing components.
- Tab state lives in local React state — no URL sync, no route changes.

## Out of scope

- No changes to `InboxOverrides`, `PubsubActivity`, `ProcessingJobs`, or any server functions.
- No new routes or nested route files.
- No design-system token changes.
