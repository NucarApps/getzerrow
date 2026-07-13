## Goal

Make the folder editor's cluttered single "Settings" tab cleaner by splitting it into focused sub-tabs and moving rarely-used power settings behind an "Advanced" disclosure — no functionality removed.

## Current problem

Everything lives in one long-scroll `Settings` tab inside `FolderEditor.tsx`: filters + rule groups, Gmail label, AI purpose/rule, learned profile, suggested domains, summaries, a 7-toggle behavior grid, surface-to-inbox, and forward/snooze/confidence inputs — all stacked together. It's hard to scan and find anything.

## New structure

The folder name / color / priority header and the shared **Save changes** bar stay at the top/bottom (unchanged). The current three top-level tabs (`Settings`, `History`, `Chat`) become five focused tabs:

```text
[ Rules ] [ AI ] [ Automation ] [ History ] [ Chat ]
```

**Rules** — deterministic matching
- Filters list + add-filter row
- Match any / Match all toggle and rule-groups switch
- Suggested domains chips (they add deterministic domain filters, so they belong here)

**AI** — how AI sorts and learns
- Gmail label link
- Describe purpose → Generate rule
- AI rule (natural language) + Draft from label / Write with chat
- Learned profile + Learn/Re-learn/Sync + Keep learning automatically
- Summaries panel
- "Rules only (skip AI)" toggle

**Automation** — what happens to matched mail
- Common toggles up front: Auto-archive, Auto mark-read, Auto-star, Hide from inbox
- Collapsible **Advanced** section (collapsed by default) holding the power settings:
  - Beat "Always send to inbox" rules
  - Cold email folder
  - Surface to inbox (AI) rule + names/aliases
  - Auto-forward to
  - Snooze on arrival (hours)
  - Min AI confidence (%)
  - Scan Gmail section

**History** and **Chat** — unchanged.

## Technical details

- All edits are confined to `src/components/folders/FolderEditor.tsx` (presentation only). No server functions, DB columns, or business logic change.
- The existing `local` state and `dirty`/`save()` flow stay as-is. Because settings now span multiple sub-tabs, the dirty **Save changes / Cancel** bar moves out of the tab content to render below the `<Tabs>` block so it's visible regardless of which sub-tab is active.
- Existing helper components (`SummariesPanel`, `ScanGmailSection`, `HistoryPanel`, `FolderChatPanel`, `RuleGroupEditor`) are reused unchanged — only their placement moves into the new tabs.
- Add a lightweight collapsible for the Advanced group using the existing shadcn `Collapsible` (or a simple `useState` + `ChevronDown`, matching patterns already in the file).
- Tab state (`tab`) default becomes `"rules"`; internal `setTab("chat")` calls (e.g. the "Write with AI chat" button) keep working with the new value.
- Keep all copy in sentence case and existing tooltips/help text intact.

## Out of scope

No changes to `AddFolderDialog.tsx`, no changes to what any setting does, and no options removed — only regrouped and de-emphasized.
