## Goal

Make the app usable on phone widths (~360–430px). Today the sidebar is permanently 256px wide and the inbox is a fixed `400px + 1fr` two-column grid, so on mobile the sidebar eats most of the screen and the reading pane is unusable.

## Changes (frontend/presentation only)

### 1. Sidebar → off-canvas drawer on mobile (`src/routes/_authenticated.tsx`)

- Below `md` (768px): hide the sidebar by default and expose it through a `Sheet` (shadcn) that slides in from the left.
- Add a slim top app bar that only renders on mobile, containing:
  - Hamburger button → opens the sidebar sheet
  - "Zerrow" wordmark
  - (Reuses existing header space; doesn't change desktop)
- At `md` and up: sidebar stays exactly as-is (`w-64`, always visible).
- Move the existing sidebar JSX into a small `SidebarContent` component so it renders both inside the persistent `<aside>` (desktop) and inside `<SheetContent side="left">` (mobile) without duplication.
- Selecting a folder or nav item on mobile auto-closes the sheet.

### 2. Inbox: single-pane on mobile (`src/routes/_authenticated/index.tsx`)

- Replace the fixed `grid-cols-[400px_1fr]` with a responsive layout:
  - Mobile (`<md`): show **either** the email list **or** the reader, controlled by `selectedId`. When an email is opened, the list is hidden and the reader takes the full width.
  - Desktop (`md+`): keep the current two-pane grid unchanged.
- Add a "Back" button (chevron-left) in the reader header that appears only on mobile and clears `selectedId`.
- Tighten reader padding on mobile: `p-4 md:p-6`, headline `text-2xl md:text-3xl`.
- Reply area: keep textarea full-width; ensure Send button row wraps cleanly.

### 3. Settings page (`src/routes/_authenticated/settings.tsx`)

- Outer padding `p-4 md:p-8`, heading `text-3xl md:text-4xl`.
- Make the "Connected Gmail accounts" card header stack vertically on mobile (`flex-col gap-3 md:flex-row md:items-center md:justify-between`) so the Reauthorize button doesn't get squeezed.
- Account action button rows: allow wrapping (`flex-wrap`) so Sync/Backfill/Renew/Disconnect don't overflow.

### 4. Folder editor sheet (`src/components/folders/EditFolderDialog.tsx`)

- Already uses `w-full sm:max-w-xl` — verify it's full-width on phones (it is). No structural change; only minor padding tweaks inside `FolderEditor` if any row overflows on a 360px viewport.

### Out of scope

- No data, server function, or routing logic changes.
- No design-token or color changes.
- Desktop layout is preserved pixel-for-pixel.

## Technical notes

- Use the existing `useIsMobile()` hook (`src/hooks/use-mobile.tsx`, breakpoint 768px) only where conditional logic is needed (e.g. auto-close sheet on folder select). For pure layout, prefer Tailwind `md:` classes to avoid SSR/hydration mismatch.
- Mobile top bar uses `sticky top-0 z-30` with `bg-background/80 backdrop-blur` so it doesn't fight the reader scroll.
- Reuse existing `Sheet`/`SheetContent` primitives (already imported elsewhere) — no new dependencies.
