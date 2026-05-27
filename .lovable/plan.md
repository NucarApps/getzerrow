## Issue

In Settings → Inbox filters, the **All / Emails / Domains** sub-tabs use the default shadcn Tabs styling. On the dark theme that renders as a gray pill (`bg-muted`) with `text-muted-foreground` triggers — gray text on gray, very low contrast, which is the "weird gray outline / can't read the text" the user is seeing.

## Fix

Restyle that one `TabsList` / `TabsTrigger` instance in `src/components/settings/InboxOverrides.tsx` to a higher-contrast segmented look that matches the rest of the settings UI:

- `TabsList`: drop the muted pill — use `bg-card border border-border rounded-md p-0.5 h-auto` so the track sits cleanly on the page background instead of looking like a gray smudge.
- `TabsTrigger`: inactive uses `text-foreground/70` (readable, not muted), active uses `bg-primary/10 text-primary` (already the project's accent treatment). Keep small padding (`px-3 py-1.5 text-xs`).

Scope: change is limited to the className props on the three `TabsTrigger`s and the `TabsList` in `InboxOverrides.tsx`. No edits to `src/components/ui/tabs.tsx` (keeps the global default intact for the rest of the app).

## Out of scope

- Outer settings tabs (Accounts / Inbox filters / Activity) — already styled with the underline variant and are not affected.
