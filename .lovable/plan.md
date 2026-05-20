# Fix tracking overlap, reuse it as inbox empty state, slow telemetry

## 1. Fix the overlapping boxes on the landing tracking view

After liftoff the page switches to the downrange tracking view, but the pre-launch "INBOX · UNREAD / 0 / ▲ INBOX ZERO" tile and the right-side telemetry panel stay rendered — they sit on top of the new tracking HUDs (the screenshot shows the INBOX·UNREAD chip overlapping the trajectory arc on the left).

**Change in `public/zerrow-landing.css`** (around line 1182): extend the `.launchpad__viewport.is-tracking` hide rule to also fade out `.viewport-counter` and `.viewport-telemetry`. After that, the only overlays visible in tracking mode are the three new HUDs (top-left badge, bottom-right downrange/apogee, top-right attitude/pitch).

## 2. Use the tracking view as the inbox empty state

Right now the inbox reading pane shows `TelemetryStandby` (a small framed mini-rocket card) when no email is selected. Replace it with a self-contained version of the same downrange tracking view used on the landing page.

**New file `src/components/inbox/TrackingStandby.tsx`** — renders the same deep-space + earth-curve + trajectory-arc + 3 HUDs (Downrange/Apogee, Attitude/Pitch, "TRACKING · DOWNRANGE" badge). It will be self-contained:
- Inline copy of the SVG arc, earth sphere, stars, attitude indicator
- Local `useState` + `setInterval` driving the slow telemetry numbers (no shared DOM IDs with the landing page, so the two views don't collide)
- Footer text: `AWAITING PAYLOAD — SELECT A TRANSMISSION` (keeps the prior empty-state message)
- Uses the same color palette and CSS variables already in the landing tracking styles

The tracking styles in `public/zerrow-landing.css` are global, so the new component can reuse the existing `.tracking`, `.tracking__sky/earth/arc/icon/hud` classes — no CSS duplication. It will render inside a positioned wrapper so it fills the reader pane.

**`src/routes/_authenticated/inbox.tsx`** — swap `<TelemetryStandby />` for `<TrackingStandby />` (line 614) and update the import. Leave `TelemetryStandby.tsx` in place but no longer referenced (safe to keep; can delete later).

## 3. Slow down the telemetry animation

Telemetry currently rips through liftoff in 8s and the readouts tick every 220ms — too frantic.

**Changes in `src/components/landing/useMissionTelemetry.ts`:**
- Inbox countdown duration: 8000ms → 18000ms (slower burn-down to 0).
- Liftoff window in `updateTelemetry`: replace the `launchT < 8` constant with `LIFT_DURATION = 22` so altitude/velocity/g/heading ramp over ~22 seconds.
- Tracking activation timeout: 1800ms → 3500ms (matches the new inbox burn-down).
- Telemetry update interval: 220ms → 600ms (numbers tick about 1/3 as fast).
- Pitch easing in tracking view: `sinceLift * 3.2` → `sinceLift * 1.2` so the rocket pitches over downrange more gradually.
- After-burn phase noise multipliers reduced (`vel` jitter ±6 → ±2, `alt` drift `* 0.4` → `* 0.12`, etc.) so the readouts drift calmly instead of flickering.

**Mirror these slower settings in `TrackingStandby.tsx`** so the inbox empty state also ticks slowly (600ms interval, gentle drift).

## Out of scope

- No layout change to the landing page besides hiding the two leftover overlays.
- No change to the Reader pane behavior — only the empty-state component swaps.
- No deletion of the old `TelemetryStandby` file in this pass.
