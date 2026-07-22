## Mobile cleanup for Contacts page

Scope: `src/routes/_authenticated/contacts.index.tsx` only. Desktop layout unchanged (`sm:` and up keeps current behavior).

### 1. Bigger contact rows on mobile
- Contact rows (line ~1260) and grouped contact rows (line ~1162): bump mobile padding/gap and avatar/text size (`py-2` → `py-3`, `gap-2.5` → `gap-3`, name text `text-sm` → `text-[15px]`) with `sm:` overrides restoring current desktop density.
- Company bucket header rows keep current sizing.

### 2. Collapsible search on mobile
- Replace the always-visible search input in the header bar (lines 902–910) with:
  - Mobile (`sm:hidden`): an icon-only Search button that toggles a `searchOpen` state.
  - Desktop (`hidden sm:block`): the current inline input, unchanged.
- When `searchOpen` is true on mobile, render a full-width expanded row below the header containing the search input (auto-focused, with a small close/X). Clearing/closing collapses it and resets `query`.

### 3. Collapsible AI strip on mobile
- Header gets a second icon-only button on mobile: the amber `Sparkles` icon (`sm:hidden`), toggling an `aiOpen` state.
- The AI chip strip (lines 965–989) becomes `hidden sm:flex` by default; on mobile it only renders when `aiOpen` is true, as an expanded row below the header (same amber background, horizontal scroll of chips, includes a close affordance).
- Desktop keeps the strip always visible exactly as today.

### 4. Behavior notes
- Only one of the two expanded rows is visible at a time on mobile (opening one closes the other) to keep the list area maximized.
- Both toggles are local `useState` in the component; no route/search-param changes.
- No changes to data fetching, filters, group pills, or bulk-action bar.

### Technical details
- New state: `const [mobileSearchOpen, setMobileSearchOpen] = useState(false)` and `const [mobileAiOpen, setMobileAiOpen] = useState(false)`.
- Header search wrapper becomes `hidden sm:block relative …`; add a mobile-only `<Button size="sm" className="h-8 w-8 p-0 sm:hidden">` with `Search` icon inside the right-side action cluster (before My card / Scan / Add). Add a matching `Sparkles` mobile-only button next to it.
- Expanded rows rendered right after the header `</div>` (before the AI strip block), each `sm:hidden`, with `border-b border-border` and internal padding matching current strips. Search row uses the same `Input` styling; AI row reuses the existing `AiChip` list.
- Contact row class updates use responsive utilities so no desktop regressions: e.g. `px-4 py-3 gap-3 sm:py-2 sm:gap-2.5` and avatar `h-10 w-10 sm:h-8 sm:w-8` if applicable (I'll match whatever the current row uses).
