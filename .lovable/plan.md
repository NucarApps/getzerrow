## Goal
Tighten the mobile Contacts header into a single row and give each contact/company row more vertical presence.

## Changes — `src/routes/_authenticated/contacts.index.tsx`

### 1. Condensed header (mobile) on a single row
Header block at line 894:
- Drop `flex-wrap` on mobile so title + action icons stay on one row; keep wrap behavior for `sm:`.
- Title `<h1>` shrinks to `text-lg` on mobile (keeps `sm:text-xl`) and gets `truncate`.
- Subtitle line (line 897–903): abbreviate to just `"{count} p"` on mobile, and drop the companies segment entirely. Desktop keeps the current `"N people · M companies"` phrasing via a `hidden sm:inline` span.
  - Mobile: `487 p`
  - Desktop: `487 people · 220 companies`
- Reduce header horizontal padding on mobile (`px-3`) to give the icon row room; `sm:px-5` unchanged.
- Tighten icon gap on mobile (`gap-1`) so Search / AI / My card / Scan / + all fit.
- The company-group toggle + collapse buttons (lines 914–943) move into the same right-aligned action cluster on mobile so everything sits on one row.

### 2. Taller rows
- Company bucket row (line 1232): mobile padding `py-3` → `py-4`; keep desktop `sm:py-2`.
- Contact row (line 1330): mobile padding `py-3` → `py-4`; keep desktop `sm:py-2.5`.
- Bump mobile avatar from `h-9 w-9` → `h-10 w-10` for balance; desktop unchanged.
- Contact name text stays `text-[15px]` on mobile.

## Out of scope
- Desktop layout, sidebar, AI strip contents, search behavior, and any business logic.
