## Problem

The "Record an in-person meeting" dialog shows "Microphone is blocked for this site" and the only affordance is "Reload page". In the Lovable preview (`id-preview--….lovable.app`), the app runs inside an iframe. Browsers block `getUserMedia` in iframes unless the parent sets `allow="microphone"`, which surfaces as `NotAllowedError` — indistinguishable from a real user denial with our current copy. Telling the user to "click the padlock" won't fix an iframe permissions-policy block, so they're stuck.

## Fix

Update `src/routes/_authenticated/meetings.tsx` recording dialog only (UI/UX, no backend changes):

1. **Detect the iframe case** before/after `getUserMedia`:
   - Check `window.self !== window.top`.
   - Probe `document.featurePolicy?.allowsFeature?.("microphone")` (and `navigator.permissions.query({name:"microphone"})` where available) to distinguish permissions-policy block from a real user denial.
2. **Branch the blocked UI** into two states with distinct copy:
   - **Iframe / policy block** (most likely cause here in preview): "Recording needs to run outside the preview frame. Open the app in a new tab to grant mic access." Primary action: **Open in new tab** → `window.open(window.location.href, "_blank")` (top-level origin — preview or published domain, whichever they're on).
   - **User-denied**: keep the current padlock instructions + "Reload page".
3. Keep existing `NotFoundError` / `NotReadableError` messages unchanged.

That's it — one file, presentation-only change. After opening in a new tab, mic prompt appears normally and recording works.
