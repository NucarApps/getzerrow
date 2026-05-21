# Fix: Power-ups stuck in the top-left corner

## Root cause

In `src/components/inbox/TrackingStandby.tsx`, each falling power-up is rendered as:

```tsx
<g transform={`translate(${p.x} ${p.y})`} className="powerup">
```

The `.powerup` class has a CSS keyframe animation that sets `transform: translateY(...)`. On SVG elements, a CSS `transform` **overrides** the `transform=""` attribute, so `translate(p.x, p.y)` is discarded and every power-up renders at (0, 0) — the top-left of the playfield. That matches the symptom ("kind of showing in the top-left, can't see them").

Enemies/bullets work fine because they don't have a CSS transform animation on their positioned `<g>`.

## Fix

Wrap the bobbing animation on an **inner** `<g>`, so the outer `<g>` keeps its positional `transform` attribute intact and the CSS animation only nudges the inner group.

```tsx
{powerupsRef.current.map((p) => {
  const color = POWERUP_COLORS[p.kind];
  return (
    <g key={p.id} transform={`translate(${p.x} ${p.y})`}>
      <g className="powerup">
        <rect x="-1.6" y="-1.2" width="3.2" height="2.4" rx="1.1"
              fill="#0a0e1a" stroke={color} strokeWidth="0.22" />
        <text x="0" y="0.55" textAnchor="middle"
              fontFamily="JetBrains Mono, ui-monospace, monospace"
              fontWeight="700" fontSize="1.8" fill={color}>
          {POWERUP_LABEL[p.kind]}
        </text>
      </g>
    </g>
  );
})}
```

No other logic changes — drop chance, fall speed, pickup, and buff application are all working; they just weren't visible because the sprites were drawing off-screen at the origin.

## Files

- `src/components/inbox/TrackingStandby.tsx` — split the power-up `<g>` into outer (position) + inner (bob animation).
