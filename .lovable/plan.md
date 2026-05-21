## Problem

On the inbox, when no email is selected, the standby panel shows only the orange trajectory arc and the "AWAITING PAYLOAD" caption — the stars, Earth horizon, rocket icon riding the arc, and corner HUDs (Downrange/Apogee/Pitch) are all missing.

## Root cause

`TrackingStandby.tsx` reuses class names from `public/zerrow-landing.css` (`.tracking__sky`, `.tracking__earth`, `.tracking__icon`, `.tracking__hud*`, the `.is-tracking` reveal, etc.). That stylesheet is currently only loaded on the landing page:

```
src/routes/index.tsx:24
{ rel: "stylesheet", href: "/zerrow-landing.css" }
```

On the `_authenticated/inbox` route the file is never linked, so:

- `.tracking { opacity: 0 }` reveal rule is missing → the inline `style={{ opacity: 1 }}` carries the arc, which is why the arc alone shows.
- The arc renders because its gradient is defined inline in the SVG, not in CSS.
- Stars (`.tracking__sky i` sizing/animation), Earth (`.tracking__earth` radial gradient), rocket icon (`.tracking__icon` offset-path + flame), and the corner HUDs all have zero styling and collapse to invisible/unsized elements.

## Fix

Add the same stylesheet link to the inbox route's `head()` so the tracking styles are available wherever `TrackingStandby` is used.

In `src/routes/_authenticated/inbox.tsx`, extend the route's `head()` `links` array with:

```ts
{ rel: "stylesheet", href: "/zerrow-landing.css" }
```

(matching the entry in `src/routes/index.tsx`). No component or CSS changes needed — the markup in `TrackingStandby` already matches the existing class names and the `.is-tracking` reveal class is already applied.

## Verification

After the change, the inbox standby panel should show: twinkling starfield, blue Earth horizon at the bottom, the rocket icon flying along the orange arc with a flame trail, and the three HUD blocks (TRACKING · DOWNRANGE top-left, attitude/pitch top-right, downrange/apogee bottom-right) — matching the post-liftoff view on the landing page.
