# Make landing page responsive

The homepage already has breakpoints at 860px and 640px, but several pieces still feel cramped on real phones (390px and below) and the launchpad visualization overlaps itself. Scope is `public/zerrow-landing.css` only — no JSX or content changes.

## Issues spotted

1. **Status bar** — three clusters (`MISSION CONTROL`, `SIGNAL/UPLINK`, `MET/NOMINAL`) all stay visible at every width; on <420px they bunch up tightly.
2. **Launchpad viewport on mobile** — the inbox-count card (top-left), telemetry rows (top-right), and rocket all stack into the same small box, overlapping each other.
3. **Hero title** is fixed-size and doesn't scale down for 320–360px screens.
4. **Section/nav horizontal padding** is heavy on small viewports.
5. **FAQ summary** grid columns can squeeze the toggle "+" on tiny widths.
6. **`hero__fineprint` / hero stats** could use a tighter rhythm on mobile.

## Changes (all in `public/zerrow-landing.css`)

### Refine existing `@media (max-width: 860px)` block
- Reduce `.hero__title` font-size; tighten `.section` vertical padding.
- Shrink `.launchpad__viewport` paddings so telemetry doesn't crowd the rocket.

### Refine existing `@media (max-width: 640px)` block
- `.viewport-counter` and `.viewport-telemetry`: reposition to top corners with smaller fonts; reduce min-width on telemetry so it doesn't overlap the rocket.
- Scale rocket SVG container down.
- Reduce `.hero__title` further; tighten letter-spacing.
- Reduce horizontal page padding (nav, sections) from current value to ~16px.
- Tighten `.hero__stats` and `.hero__cta` button sizing.
- Hide the middle `SIGNAL/UPLINK` cluster (`.status-cluster:nth-child(2)`) to prevent crowding.

### Add new `@media (max-width: 420px)` block
- Hide the `SIGNAL`/`UPLINK` cluster entirely; keep `MISSION CONTROL` and `MET`.
- Further shrink `.hero__title` (~44px), `.t-minus__big`, and `.section-title`.
- Stack `.launchpad__foot` cells into a 2-column grid instead of 4.
- Reduce launchpad min-height so it doesn't take a full extra screen.

## Out of scope
- No content/JSX changes in `src/routes/index.tsx`.
- No changes to the rocket animation logic.
- No changes to fonts loaded or color tokens.
