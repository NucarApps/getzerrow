# Fix greyed-out tabs

## What's happening

On the published site, inactive tabs render as a solid light‑grey block with barely‑readable text (sampled color RGB 141,147,157 — the "muted text" color being painted as a background). The active tab, by contrast, sits dark. The result reads as "greyed out." This affects every tab surface in the app (meeting Summary/Transcript, Settings, Folders, Contacts) because they all share one component: `src/components/ui/tabs.tsx`.

The current source and dark theme tokens are actually correct, so part of the reason the live site looks wrong is that the published build is behind. The fix hardens the shared tab styling to guarantee a dark, subtle, readable look and then republishes so the live site picks it up.

## Target look

- Inactive tab: blends into the dark tab bar, no light-grey fill, label clearly legible (muted but readable), subtle hover.
- Active tab: clearly highlighted with a slightly lighter surface + soft shadow and full-strength text.

## Changes

1. `src/components/ui/tabs.tsx` — the single shared component
   - `TabsList`: keep it a dark, contained bar (dark muted/secondary surface with a hairline border), so nothing inside can read as a light block.
   - `TabsTrigger` (inactive): transparent background, `text-muted-foreground` for a readable-but-subdued label, a gentle `hover:text-foreground` / faint hover surface.
   - `TabsTrigger` (active): lighter card-style surface (`data-[state=active]` → card/background token), `text-foreground`, subtle shadow so the selected tab clearly stands out against the dark bar.
   - Keep the existing focus ring and disabled states.

2. Republish so the live published site (getzerrow.com) reflects the corrected styling.

## Technical notes

- Only presentation classes in the shared UI component change — no logic, no per-page tab code, no backend. All existing `Tabs`/`TabsList`/`TabsTrigger`/`TabsContent` usages keep working unchanged.
- Uses existing semantic tokens only (`--muted`, `--card`, `--background`, `--foreground`, `--border`, `--ring`) — no hardcoded colors, consistent in the dark palette.
- After the edit I'll verify the rendered tabs against the dark theme before republishing.
