# Fix: mobile toasts never auto-dismiss

## Problem
On mobile, toast notifications at the bottom of the screen stay on screen forever instead of disappearing after a few seconds.

## Cause
The shared `Toaster` (`src/components/ui/sonner.tsx`) is configured without an explicit auto-dismiss duration and without a manual close affordance. Sonner pauses its dismiss timer on hover/touch and when the page loses focus, then resumes on the matching `pointerleave`/focus event. On mobile browsers those resume events frequently never fire, so paused toasts linger indefinitely.

## Fix
Update only the `Toaster` configuration in `src/components/ui/sonner.tsx`:

1. Set an explicit `duration` (4000ms) so every toast has a definite lifetime.
2. Add `closeButton` so users always have a guaranteed way to dismiss a toast manually if a timer ever stalls — important on touch devices.
3. Keep all existing styling/classNames intact.

This is a single, presentation-only change in one file. No changes to any `toast.*` call sites are needed. Long-lived toasts that are intentional (e.g. `toast.loading(...)` that gets resolved later in `FolderEditor.tsx`) keep working because they pass their own id and are updated/closed explicitly.

## Verification
- On the live site / preview at mobile width, trigger a toast (e.g. refresh inbox, save a folder) and confirm it auto-dismisses after ~4s.
- Confirm a close (×) control is available to dismiss manually.
- Confirm loading toasts (digest generation) still resolve to success/error rather than getting force-closed early.

## Technical detail
In `src/components/ui/sonner.tsx`, add `duration={4000}` and `closeButton` props to the `<Sonner />` element (alongside the existing `toastOptions`).
