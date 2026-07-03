## Goal

Keep both top-nav buttons but make them clearly different so they no longer look redundant.

## Change

In `src/routes/index.tsx`, the nav (`.nav__cta`) currently has:

- Ghost button: "Sign in" → `/login`
- Primary button: "Connect Gmail →" → `/login`

Relabel so each speaks to a different audience:

- Ghost button (returning users): **"Sign in"** — unchanged label, kept as the secondary action.
- Primary button (new users): **"Get started"** with the `→` arrow — reframed as the new-user call to action.

Both continue to route to `/login`, matching the existing hero and CTA-section buttons.

## Scope

- Frontend copy-only change in the nav of `src/routes/index.tsx`.
- No routing, styling, layout, or backend changes.
- Hero and bottom CTA buttons stay as they are (they already read as "Connect Gmail" / "Get started — it's free").

## Verify

Load `/` in the preview and confirm the nav shows "Sign in" and "Get started" as two distinct-looking actions.