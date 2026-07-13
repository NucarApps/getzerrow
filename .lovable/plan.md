# Fix the game + level up the graphics

## The real bug (why bullets vanish at the edges)

When we widened the field from 100 to 160 units, one line in the game loop was
missed. In `src/lib/invader/useInvaderGame.ts` (player-bullet travel), bullets
are deleted the instant `b.x >= 102` — the old field's right edge. So any shot
you fire while the ship is past the center-right is culled on the same frame and
never appears. That's exactly the "bullets only in the middle" symptom.

**Fix:** cull against the real field width (`FIELD_W`) instead of the hardcoded
`102`, so bullets live across the entire widened field.

## Fill edge-to-edge

Today the play surface keeps its aspect ratio and centers, leaving gaps on a
wide screen. You chose full edge-to-edge fill.

- Make the SVG viewBox track the container's real aspect ratio (measure the
  container, keep the world width at `FIELD_W`, extend the vertical view to
  match) so the field paints corner-to-corner with no bars and no distortion.
- Anchor the player lane and bunkers to the bottom of the visible area so
  nothing important gets pushed off-screen at wide/short sizes.
- Extend the starfield and background wash to cover the full surface.

## Better graphics (all four directions you picked)

**Richer glow & lighting**
- Stronger, layered glow filters on the ship, bullets, enemies, boss and UFO.
- Brighter bloom cores on explosions; add a soft additive light around the
  player ship and active shield.
- Punchier accent colors per enemy type with subtle inner gradients.

**More detailed sprites**
- Redesign enemies from flat rectangles into layered "envelope" bodies with a
  gradient face, seal/stamp detail, antenna glints and a colored rim light.
- Give the player ship a soft engine plume and cockpit glow; boss gets plating,
  eye glow and a cleaner health bar; UFO gets a domed canopy with light beam.

**Livelier background**
- Deeper multi-layer parallax starfield (3 depths, varied brightness/drift).
- Slow-drifting nebula gradients + a very subtle horizon grid for depth,
  tuned low-opacity so it never competes with gameplay.

**Juicier effects**
- Muzzle flash on fire, bullet trails, richer hit sparks and debris on kills.
- Snappier screen shake with easing, brief flash on player hit, and a small
  scale-pop on explosions.
- Respect reduced-motion (the game already checks it) — heavy effects scale
  down when that's on.

## Files touched
- `src/lib/invader/useInvaderGame.ts` — bullet cull bound fix; any bottom-anchor
  math for player/bunkers.
- `src/components/inbox/invader/GameField.tsx` — glow filters, redesigned
  sprites, effects, responsive viewBox.
- `src/components/inbox/TrackingStandby.tsx` — full-bleed layout + upgraded
  background/starfield.

## Verification
- `tsgo` typecheck.
- Playwright at a wide viewport: start the game, move the ship to the far right,
  fire, and confirm bullets render and hit at the right edge; capture a
  screenshot to review the new visuals edge-to-edge.

No engine rules, scoring, or backend logic change — this is spatial + visual.
