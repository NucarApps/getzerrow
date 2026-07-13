import { memo, useEffect, useReducer, useState } from "react";
import shipUrl from "@/assets/zerrow-ship.png";
import {
  BUNKER_CELL,
  BUNKER_COLS,
  BUNKER_ROWS,
  BURST_MS,
  COL_GAP,
  ENEMY_COLORS,
  ENEMY_HALF_H,
  ENEMY_HALF_W,
  FIELD_H,
  FIELD_W,
  PLAYER_Y,
  POWERUP_COLORS,
  POWERUP_LABEL,
  ROW_GAP,
} from "@/lib/invader/engine";
import type { EnemyKind } from "@/lib/invader/engine";
import type { LiveGame } from "@/lib/invader/useInvaderGame";

type Props = {
  getLive: () => LiveGame;
  subscribe: (listener: () => void) => () => void;
  containerRef: React.MutableRefObject<HTMLDivElement | null>;
  phase: "ready" | "playing" | "paused" | "over";
  lives: number;
  isMovingHint: boolean;
};

// Ship native aspect ratio (source PNG). In the widescreen viewBox the units
// are uniform (preserveAspectRatio meet), so the ship draws with true aspect.
const SHIP_SRC_RATIO = 187 / 265;
const SHIP_H = 9;
const SHIP_W = SHIP_H * SHIP_SRC_RATIO;

const WORLD_AR = FIELD_W / FIELD_H;

// Compute a viewBox that always contains the full play field and fills the
// container edge-to-edge without distortion. Extra room becomes background
// (starfield / nebula) rather than cropping gameplay: wider containers extend
// the world horizontally (centered), taller containers extend it upward so the
// player lane stays anchored to the bottom.
function computeViewBox(w: number, h: number) {
  if (w <= 0 || h <= 0) return { minX: 0, minY: 0, vbW: FIELD_W, vbH: FIELD_H };
  const ar = w / h;
  if (ar >= WORLD_AR) {
    const vbH = FIELD_H;
    const vbW = FIELD_H * ar;
    return { minX: (FIELD_W - vbW) / 2, minY: 0, vbW, vbH };
  }
  const vbW = FIELD_W;
  const vbH = FIELD_W / ar;
  return { minX: 0, minY: FIELD_H - vbH, vbW, vbH };
}

// Deterministic multi-layer starfield spread across the widest plausible
// viewBox. Three depths: far (dim, tiny), mid, near (bright, larger). Drawn
// inside the SVG so it stays world-aligned and fills the extended background.
type Star = { x: number; y: number; r: number; base: number; depth: number };
const STARS: Star[] = (() => {
  let s = 0x9e3779b9;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out: Star[] = [];
  const layers = [
    { count: 70, r: 0.18, base: 0.3, depth: 3 },
    { count: 45, r: 0.28, base: 0.5, depth: 6 },
    { count: 24, r: 0.42, base: 0.75, depth: 10 },
  ];
  for (const l of layers) {
    for (let i = 0; i < l.count; i++) {
      out.push({
        x: -90 + rand() * (FIELD_W + 180),
        y: -50 + rand() * (FIELD_H + 50),
        r: l.r,
        base: l.base,
        depth: l.depth,
      });
    }
  }
  return out;
})();



function GameFieldImpl({ getLive, subscribe, containerRef, phase, lives, isMovingHint }: Props) {
  // Force re-render on each engine frame via a subscription rather than a
  // parent re-render. Cheap counter, batched by React.
  const [, force] = useReducer((x: number) => (x + 1) & 0xffff, 0);
  useEffect(() => {
    return subscribe(force);
  }, [subscribe]);

  // Track the container size so the viewBox can fill it edge-to-edge.
  const [view, setView] = useState(() => computeViewBox(0, 0));
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setView(computeViewBox(el.clientWidth, el.clientHeight));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [containerRef]);

  // Read live data each render (refs are stable; no allocation).
  const live = getLive();
  const now = performance.now();
  const shakeAmt = live.shakeUntil > now ? Math.max(0, (live.shakeUntil - now) / 220) : 0;
  // Eased shake feels snappier than linear.
  const shake = shakeAmt * shakeAmt;
  const dx = shake > 0 ? (Math.random() - 0.5) * shake * 7 : 0;
  const dy = shake > 0 ? (Math.random() - 0.5) * shake * 7 : 0;
  const invulnUntil = live.shieldUntil > now ? live.shieldUntil : live.invulnUntil;

  const viewBox = `${view.minX} ${view.minY} ${view.vbW} ${view.vbH}`;

  return (
    <div
      ref={containerRef}
      className="pointer-events-auto relative h-full w-full overflow-hidden"
      style={{ transform: `translate(${dx}px, ${dy}px)` }}
      tabIndex={0}
    >
      <svg
        className="absolute inset-0 z-10"
        viewBox={viewBox}
        preserveAspectRatio="xMidYMid meet"
        style={{ width: "100%", height: "100%" }}
      >
        <defs>
          {/* Background depth washes */}
          <radialGradient id="nebulaA" cx="28%" cy="26%" r="55%">
            <stop offset="0%" stopColor="#3a2a6a" stopOpacity="0.32" />
            <stop offset="100%" stopColor="#3a2a6a" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="nebulaB" cx="76%" cy="18%" r="50%">
            <stop offset="0%" stopColor="#0d4a5a" stopOpacity="0.28" />
            <stop offset="100%" stopColor="#0d4a5a" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="nebulaC" cx="60%" cy="88%" r="70%">
            <stop offset="0%" stopColor="#ff5a2e" stopOpacity="0.1" />
            <stop offset="100%" stopColor="#ff5a2e" stopOpacity="0" />
          </radialGradient>

          <linearGradient id="horizonGlow" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ff5a2e" stopOpacity="0.14" />
            <stop offset="100%" stopColor="#ff5a2e" stopOpacity="0" />
          </linearGradient>
          <radialGradient id="bossGlow">
            <stop offset="0%" stopColor="#ff5a8a" stopOpacity="0.9" />
            <stop offset="100%" stopColor="#ff5a8a" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="shipGlow">
            <stop offset="0%" stopColor="#ff8a3d" stopOpacity="0.5" />
            <stop offset="100%" stopColor="#ff8a3d" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="ufoGlow">
            <stop offset="0%" stopColor="#ffe066" stopOpacity="0.55" />
            <stop offset="100%" stopColor="#ffe066" stopOpacity="0" />
          </radialGradient>
          {/* Vertical body sheen used on enemies for a lit, 3D-ish face */}
          <linearGradient id="bodySheen" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.22" />
            <stop offset="45%" stopColor="#ffffff" stopOpacity="0.05" />
            <stop offset="100%" stopColor="#000000" stopOpacity="0.28" />
          </linearGradient>

          {/* Soft, cheap glow used broadly on lit elements. */}
          <filter id="softGlow" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="0.7" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          {/* Stronger bloom reserved for hero elements (ship, boss, bursts). */}
          <filter id="strongGlow" x="-120%" y="-120%" width="340%" height="340%">
            <feGaussianBlur stdDeviation="1.6" result="b1" />
            <feGaussianBlur stdDeviation="0.6" result="b2" />
            <feMerge>
              <feMergeNode in="b1" />
              <feMergeNode in="b2" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* ---- Background: fills the whole (possibly extended) viewBox ---- */}
        <rect
          x={view.minX}
          y={view.minY}
          width={view.vbW}
          height={view.vbH}
          fill="#02030a"
        />
        <rect x={view.minX} y={view.minY} width={view.vbW} height={view.vbH} fill="url(#nebulaA)" />
        <rect x={view.minX} y={view.minY} width={view.vbW} height={view.vbH} fill="url(#nebulaB)" />
        <rect x={view.minX} y={view.minY} width={view.vbW} height={view.vbH} fill="url(#nebulaC)" />

        {/* Parallax starfield — slow horizontal drift + gentle twinkle */}
        <g>
          {STARS.map((st, i) => {
            const drift = ((now / 1000) * (st.depth * 0.15)) % (FIELD_W + 180);
            let sx = st.x - drift;
            if (sx < -90) sx += FIELD_W + 180;
            const tw = st.base * (0.7 + 0.3 * Math.sin(now / 700 + i));
            return <circle key={`star-${i}`} cx={sx} cy={st.y} r={st.r} fill="#dfe7ff" opacity={tw} />;
          })}
        </g>


        {/* Subtle depth grid toward the horizon */}
        <g stroke="#7cc4ff" strokeOpacity="0.05" strokeWidth="0.15">
          {Array.from({ length: 9 }).map((_, i) => {
            const gx = view.minX + (view.vbW * (i + 1)) / 10;
            return <line key={`gv-${i}`} x1={gx} y1={PLAYER_Y - 30} x2={gx} y2={PLAYER_Y + 6} />;
          })}
          {Array.from({ length: 4 }).map((_, i) => {
            const gy = PLAYER_Y - 24 + i * 8;
            return (
              <line key={`gh-${i}`} x1={view.minX} y1={gy} x2={view.minX + view.vbW} y2={gy} />
            );
          })}
        </g>

        {/* Faint horizon line + glow above the player lane */}
        <line
          x1={view.minX}
          y1={PLAYER_Y + 4}
          x2={view.minX + view.vbW}
          y2={PLAYER_Y + 4}
          stroke="#ff8a3d"
          strokeOpacity="0.26"
          strokeWidth="0.22"
        />
        <rect
          x={view.minX}
          y={PLAYER_Y + 4}
          width={view.vbW}
          height={view.minY + view.vbH - (PLAYER_Y + 4)}
          fill="url(#horizonGlow)"
        />

        {/* Bunkers — rounded, softly lit shield blocks */}
        {live.bunkers.map((b) => {
          const totalW = BUNKER_COLS * BUNKER_CELL;
          const totalH = BUNKER_ROWS * BUNKER_CELL;
          const left = b.x - totalW / 2;
          const top = b.y - totalH / 2;
          return (
            <g key={b.id}>
              {b.cells.map((row, r) =>
                row.map((on, c) =>
                  on ? (
                    <rect
                      key={`${b.id}-${r}-${c}`}
                      x={left + c * BUNKER_CELL + 0.05}
                      y={top + r * BUNKER_CELL + 0.05}
                      width={BUNKER_CELL - 0.1}
                      height={BUNKER_CELL - 0.1}
                      rx="0.2"
                      fill="#5ff0ad"
                      opacity={0.55}
                    />
                  ) : null,
                ),
              )}
            </g>
          );
        })}

        {/* Player bullets — glowing rounded shots with a bright trail */}
        {live.bullets.map((b) => {
          const color = b.pierce ? "#ffe066" : "#fff5e0";
          return (
            <g key={b.id} filter="url(#softGlow)">
              <rect
                x={b.x - 0.55}
                y={b.y - 2.6}
                width="1.1"
                height="4.2"
                rx="0.55"
                fill={color}
                opacity={0.16}
              />
              <rect x={b.x - 0.24} y={b.y - 1.9} width="0.48" height="2.8" rx="0.24" fill={color} />
              <circle cx={b.x} cy={b.y - 1.9} r="0.45" fill="#ffffff" />
            </g>
          );
        })}

        {/* Enemy bullets — soft red darts */}
        {live.enemyBullets.map((b) => (
          <g key={b.id}>
            <rect
              x={b.x - 0.55}
              y={b.y - 1.8}
              width="1.1"
              height="3"
              rx="0.5"
              fill="#ff5a2e"
              opacity={0.18}
            />
            <rect x={b.x - 0.26} y={b.y - 1.2} width="0.52" height="2.4" rx="0.26" fill="#ff6b3d" />
          </g>
        ))}

        {/* Enemies — layered envelope sprites with rim light + sheen */}
        {live.enemies.map((e) => {
          if (!e.alive) return null;
          const offset = e.kind === "phishing" ? Math.sin(e.zig) * 2 : 0;
          const ex = live.formationX + e.col * COL_GAP + offset;
          const ey = live.formationY + e.row * ROW_GAP;
          const flashing = e.hitUntil > now;
          const colors = ENEMY_COLORS[e.kind as EnemyKind];
          const bodyFill = flashing ? "#fff5e0" : colors.body;
          const w = ENEMY_HALF_W * 2;
          const h = ENEMY_HALF_H * 2;
          return (
            <g key={e.id} transform={`translate(${ex} ${ey})`}>
              {/* colored rim halo */}
              <rect
                x={-ENEMY_HALF_W - 0.6}
                y={-ENEMY_HALF_H - 0.6}
                width={w + 1.2}
                height={h + 1.2}
                rx="1"
                fill={colors.accent}
                opacity={flashing ? 0.42 : 0.16}
              />
              {/* body */}
              <rect
                x={-ENEMY_HALF_W}
                y={-ENEMY_HALF_H}
                width={w}
                height={h}
                rx="0.6"
                fill={bodyFill}
                stroke={colors.accent}
                strokeWidth="0.24"
              />
              {/* lit sheen overlay */}
              <rect
                x={-ENEMY_HALF_W}
                y={-ENEMY_HALF_H}
                width={w}
                height={h}
                rx="0.6"
                fill="url(#bodySheen)"
              />
              {/* envelope flap */}
              <path
                d={`M ${-ENEMY_HALF_W} ${-ENEMY_HALF_H} L 0 ${-ENEMY_HALF_H + 1.8} L ${ENEMY_HALF_W} ${-ENEMY_HALF_H}`}
                fill="none"
                stroke={colors.accent}
                strokeWidth="0.24"
                strokeLinejoin="round"
              />
              {/* antenna glints */}
              <circle cx={-ENEMY_HALF_W + 0.5} cy={-ENEMY_HALF_H - 0.35} r="0.28" fill={colors.stamp} />
              <circle cx={ENEMY_HALF_W - 0.5} cy={-ENEMY_HALF_H - 0.35} r="0.28" fill={colors.stamp} />
              {/* address line */}
              <line
                x1={-ENEMY_HALF_W + 0.6}
                y1={ENEMY_HALF_H - 1.1}
                x2={ENEMY_HALF_W - 0.6}
                y2={ENEMY_HALF_H - 1.1}
                stroke={colors.accent}
                strokeOpacity="0.55"
                strokeWidth="0.16"
              />
              {/* stamp */}
              <rect
                x={ENEMY_HALF_W - 1.25}
                y={-ENEMY_HALF_H + 0.35}
                width="0.9"
                height="0.9"
                rx="0.15"
                fill={colors.stamp}
              />
              {e.kind === "urgent" && (
                <text
                  x="0"
                  y={ENEMY_HALF_H - 1.3}
                  textAnchor="middle"
                  fontFamily="JetBrains Mono, monospace"
                  fontSize="1.4"
                  fontWeight="700"
                  fill={colors.stamp}
                >
                  !
                </text>
              )}
            </g>
          );
        })}

        {/* Boss — plated hull, eye glow, clean health bar */}
        {live.boss && (
          <g transform={`translate(${live.boss.x} ${live.boss.y})`}>
            <circle r="8" fill="url(#bossGlow)" />
            <g filter="url(#strongGlow)">
              <rect
                x="-5"
                y="-3.5"
                width="10"
                height="7"
                rx="1"
                fill="#3a0d12"
                stroke="#ff5a8a"
                strokeWidth="0.3"
              />
              <rect x="-5" y="-3.5" width="10" height="7" rx="1" fill="url(#bodySheen)" />
              <path
                d="M -5 -3.5 L 0 0.6 L 5 -3.5"
                fill="none"
                stroke="#ff5a8a"
                strokeWidth="0.3"
                strokeLinejoin="round"
              />
              {/* eyes */}
              <circle cx="-2.2" cy="-1" r="0.7" fill="#ffd400" />
              <circle cx="2.2" cy="-1" r="0.7" fill="#ffd400" />
              <rect x="-5" y="2" width="10" height="0.9" rx="0.25" fill="#ffd400" />
              <text
                x="0"
                y="0.5"
                textAnchor="middle"
                fontFamily="JetBrains Mono, monospace"
                fontSize="1.6"
                fontWeight="700"
                fill="#ffd400"
              >
                SPAM
              </text>
            </g>
            <rect x="-6" y="-5.5" width="12" height="0.7" rx="0.35" fill="#3a0d12" />
            <rect
              x="-6"
              y="-5.5"
              width={12 * Math.max(0, live.boss.hp / live.boss.maxHp)}
              height="0.7"
              rx="0.35"
              fill="#ff5a8a"
            />
          </g>
        )}

        {/* UFO — domed canopy + light beam */}
        {live.ufo && (
          <g transform={`translate(${live.ufo.x} ${live.ufo.y})`}>
            <circle r="4" fill="url(#ufoGlow)" />
            <g filter="url(#softGlow)">
              <polygon points="0,3.4 -3.4,1.2 3.4,1.2" fill="#ffe066" opacity="0.14" />
              <ellipse cx="0" cy="0" rx="3.4" ry="1.1" fill="#ffe066" />
              <ellipse cx="0" cy="0" rx="3.4" ry="1.1" fill="url(#bodySheen)" />
              <ellipse cx="0" cy="-0.5" rx="1.7" ry="0.9" fill="#fff5e0" />
              <text
                x="0"
                y="0.5"
                textAnchor="middle"
                fontFamily="JetBrains Mono, monospace"
                fontSize="0.9"
                fontWeight="700"
                fill="#3a0d12"
              >
                VIP
              </text>
            </g>
          </g>
        )}

        {/* Powerups */}
        {live.powerups.map((p) => {
          const color = POWERUP_COLORS[p.kind];
          return (
            <g key={p.id} transform={`translate(${p.x} ${p.y})`} filter="url(#softGlow)">
              <rect
                x="-1.9"
                y="-1.4"
                width="3.8"
                height="2.8"
                rx="1.3"
                fill={color}
                opacity="0.16"
              />
              <rect
                x="-1.6"
                y="-1.2"
                width="3.2"
                height="2.4"
                rx="1.1"
                fill="#0a0e1a"
                stroke={color}
                strokeWidth="0.24"
              />
              <text
                x="0"
                y="0.55"
                textAnchor="middle"
                fontFamily="JetBrains Mono, monospace"
                fontWeight="700"
                fontSize="1.8"
                fill={color}
              >
                {POWERUP_LABEL[p.kind]}
              </text>
            </g>
          );
        })}

        {/* Particles — soft sparks */}
        {live.particles.map((p) => {
          const a = 1 - p.life / p.ttl;
          return (
            <rect
              key={p.id}
              x={p.x - 0.24}
              y={p.y - 0.24}
              width="0.48"
              height="0.48"
              rx="0.24"
              fill={p.color}
              opacity={a}
            />
          );
        })}

        {/* Bursts — eased expanding ring with a bright bloom core */}
        {live.bursts.map((b) => {
          const t = Math.min(1, (now - b.startedAt) / BURST_MS);
          const eased = 1 - (1 - t) * (1 - t);
          const scale = b.big ? 1.8 : 1;
          const r = (2 + eased * 8) * scale;
          const fade = 1 - t;
          const pop = 1 + (1 - eased) * 0.4; // brief scale-pop early on
          return (
            <g
              key={b.id}
              transform={`translate(${b.x} ${b.y}) scale(${pop})`}
              filter="url(#strongGlow)"
            >
              <circle
                r={r}
                fill="none"
                stroke="#ff8a3d"
                strokeWidth={0.9 * fade * scale}
                opacity={fade}
              />
              <circle
                r={r * 0.55}
                fill="none"
                stroke="#ffd089"
                strokeWidth={0.5 * fade * scale}
                opacity={fade * 0.8}
              />
              <circle r={1.6 * fade * scale} fill="#fff5e0" opacity={fade} />
            </g>
          );
        })}

        {/* Floating text */}
        {live.floats.map((f) => {
          const age = (now - f.startedAt) / 900;
          return (
            <text
              key={f.id}
              x={f.x}
              y={f.y}
              textAnchor="middle"
              fontFamily="JetBrains Mono, monospace"
              fontWeight="700"
              fontSize="2"
              fill={f.color}
              opacity={1 - age}
            >
              {f.text}
            </text>
          );
        })}

        {/* Player rocket */}
        {(phase !== "over" || lives > 0) && (
          <g
            transform={`translate(${live.playerX} ${PLAYER_Y})`}
            className={now < invulnUntil ? "invuln" : undefined}
          >
            {/* additive light around the ship */}
            <circle cx="0" cy="-1" r="6" fill="url(#shipGlow)" />
            {isMovingHint && (
              <g className="thruster">
                <polygon points="-1,3 1,3 0,6.4" fill="#ff8a3d" />
                <polygon points="-0.5,3 0.5,3 0,5" fill="#ffe066" />
              </g>
            )}
            <image
              href={shipUrl}
              x={-SHIP_W / 2}
              y={-5.2}
              width={SHIP_W}
              height={SHIP_H}
              preserveAspectRatio="xMidYMid meet"
              filter="url(#strongGlow)"
            />
            {live.shieldUntil > now && (
              <circle
                r="6"
                fill="none"
                stroke="#7cc4ff"
                strokeWidth="0.4"
                opacity={0.55 + 0.45 * Math.sin(now / 80)}
                filter="url(#softGlow)"
              />
            )}
          </g>
        )}
      </svg>
    </div>
  );
}

// Memo: parent re-renders (score, combo, etc.) must NOT re-render GameField;
// it self-renders via subscribe(). Props are all primitive/stable refs.
export const GameField = memo(GameFieldImpl);
