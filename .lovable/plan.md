# Port Mission Control landing to `/`

Replace the current `src/routes/index.tsx` with a faithful React port of the uploaded `Zerrow.html`, including the rocket launchpad visual, telemetry counters, and mission elapsed time clock.

## Files

1. **`public/zerrow-landing.css`** — copy uploaded `styles.css` verbatim. Loaded only on the home route via a `<link>` in `head()` so its global selectors (`html, body`, `body::before`, etc.) don't leak into authenticated routes.
2. **`src/routes/index.tsx`** — rewrite as a 1:1 JSX port of the HTML body. Convert `class` → `className`, self-close void tags, inline the rocket SVG. Replace the obfuscated Cloudflare email with a plain string. Keep all element `id`s (`inbox-count`, `rocket`, `met-val`, `footer-met`, `hero-clock`, `t-alt`, `t-vel`, `t-thrust`, `t-fuel`, `t-g`, `t-hdg`, `foot-routed`, `foot-lat`, `stat-routed`, `uplink-val`, `inbox-delta`) so the telemetry hook targets them by id.
3. **`src/components/landing/useMissionTelemetry.ts`** — port `telemetry.js` to a React hook that runs once in `useEffect` on mount: inbox 1247→0 burn-down (8s ease-out), rocket `.lifted` class toggle, MET clock, T-3→T-0 hero clock, and the periodic altitude/velocity/thrust/fuel/g/heading/uplink updates. Cleanup cancels rAF and intervals on unmount.
4. **Remove** `src/components/landing/RocketCountdown.tsx` (replaced by the inline mission-control launchpad).

## Routing wiring

- Header "Sign in" and "Connect Gmail" → `<Link to="/login">`.
- Liftoff CTA "Get started" → `<Link to="/login">`.
- Footer "Sign in" → `<Link to="/login">`.
- Footer "Privacy" → `<Link to="/privacy">`, "Terms" → `<Link to="/terms">`.
- Section anchors (`#features`, `#how`, `#faq`, `#cta`) stay as plain `<a href="#...">` for in-page scroll.

## Preserve

- Existing `beforeLoad` redirect to `/inbox` for authenticated sessions.
- Existing `head()` SEO meta (title, description, og/twitter).
- Add Google Fonts preconnect + `Space Grotesk` / `JetBrains Mono` `<link>` tags to `head()`.

## Out of scope

No changes to other routes, auth, or backend behavior. Pure presentation port of the landing page.
