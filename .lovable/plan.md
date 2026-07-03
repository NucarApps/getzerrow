# Simplify the public homepage

Rebuild `src/routes/index.tsx` around the chosen **Centered hero, one dashboard** direction: keep the space / mission-control theme, the dark near-black + orange (`#ff5a2c`) palette, and the Space Grotesk / JetBrains Mono fonts — just far less visual noise and a cleaner vertical rhythm.

## What changes (visual)

**Top telemetry bar — kept but calmed.** One thin row instead of a busy HUD: `Status // Active`, a centered "Sorting sequence" pill, and one or two live readouts. Drop the duplicated signal bars / MET / NOMINAL cluster.

**Nav — unchanged in function.** Logo left, `Features / How it works / FAQ` center, `Sign in` + `Connect Gmail` right. Real links stay (`Link to="/login"`).

**Hero — centered, single column.** Small mono directive chip, one big headline ("An inbox that sorts itself" styled with the orange gradient accent), one concise subhead, and the two existing CTAs stacked centered. This removes the split left-text / right-launchpad layout.

**One dashboard mockup.** Replace the large animated launchpad with a single calm, static "inbox sorting" panel (window chrome + a short sorting stream on the left and a focal completion stat on the right). No constant blinking readouts — at most one subtle pulse.

**Stats row — 3 real metrics** in a clean divided row directly under the dashboard (messages routed · last 24h, classification accuracy, median sort time) using the app's existing truthful numbers, not invented ones.

**Features — tightened.** Collapse the current 6-card grid into a calmer set of clean bordered cards with numbered badges, using the real feature copy (folder profiles, real-time sorting, one-line AI summaries, learns from your moves, reanalyze on demand, suggested replies). Kept as a 3-column grid with reduced chrome (no per-card kickers/countdowns).

**How it works — kept, simplified** to the 3 steps (Connect Gmail → Describe your folders → Open a clean inbox) as a light 3-column row, dropping the STAGE/T-2 decoration.

**FAQ — kept** as the existing accordion, with the section header simplified (single title, drop the STAGE 01 / T-1 / kicker stack).

**CTA + footer — kept, streamlined** ("Ready for ignition?"-style closer with the primary CTA, then the footer links).

Removed across the page: `STAGE 0X · PAYLOAD` labels, the `T-3 / T-2 / T-1` countdown blocks, and most duplicated mono kickers — the theme reads through the palette, fonts, and one telemetry bar instead of repeating everywhere.

## Content integrity

- Keep real copy and the app's real value props; no placeholder/marketing filler (no invented "SOC2", "1.2M emails", fake latency). Reuse the truthful stats already on the page.
- Keep both CTA paths pointing to `/login`, and keep the `#features` / `#how` / `#faq` anchor nav working.
- Keep the existing `head()` metadata (title, description, OG/Twitter, FAQ JSON-LD, canonical) intact.

## Technical approach

- **`src/routes/index.tsx`** — rewrite the `LandingPage` JSX to the simplified structure above. Keep the `Route` definition and `head()` block unchanged.
- **Styling** — the page uses `public/zerrow-landing.css` (loaded via a `<link>` in `head()`, which is the correct pattern here). Add/adjust classes for the new centered hero, single dashboard panel, calmed status bar, and tightened feature cards. Fonts continue to load via the existing Google Fonts `<link>` in `head()` — no change to font loading.
- **`useMissionTelemetry`** — the animated launchpad is being removed. Trim the hook to only what the calmed status bar still needs (or drop it if nothing remains dynamic), so there's no dead animation code.
- No backend, data, or auth changes — this is frontend/presentation only.

## Verification

- Load `/` in the preview at desktop width and screenshot top-to-bottom: confirm centered hero, single dashboard, calm telemetry bar, tightened features, and that How it works / FAQ / CTA / footer still render.
- Confirm nav anchors scroll correctly and both CTAs route to `/login`.
- Check mobile width for stacking.
- Typecheck stays green.
