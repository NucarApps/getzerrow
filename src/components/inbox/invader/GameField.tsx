import { memo, useEffect, useReducer } from "react";
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
  FIELD_W,
  PLAYER_Y,
  POWERUP_COLORS,
  POWERUP_LABEL,
  ROW_GAP,
} from "@/lib/invader/engine";
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

function GameFieldImpl({ getLive, subscribe, containerRef, phase, lives, isMovingHint }: Props) {
  // Force re-render on each engine frame via a subscription rather than a
  // parent re-render. Cheap counter, batched by React.
  const [, force] = useReducer((x: number) => (x + 1) & 0xffff, 0);
  useEffect(() => {
    return subscribe(force);
  }, [subscribe]);

  // Read live data each render (refs are stable; no allocation).
  const live = getLive();
  const now = performance.now();
  const shake = live.shakeUntil > now ? Math.max(0, (live.shakeUntil - now) / 220) : 0;
  const dx = shake > 0 ? (Math.random() - 0.5) * shake * 6 : 0;
  const dy = shake > 0 ? (Math.random() - 0.5) * shake * 6 : 0;
  const invulnUntil = live.shieldUntil > now ? live.shieldUntil : live.invulnUntil;

  return (
    <div
      ref={containerRef}
      className="pointer-events-auto relative h-full w-full overflow-hidden"
      style={{ transform: `translate(${dx}px, ${dy}px)` }}
      tabIndex={0}
    >
      <svg
        className="absolute inset-0 z-10"
        viewBox={`0 0 ${FIELD_W} 100`}
        preserveAspectRatio="xMidYMid meet"
        style={{ width: "100%", height: "100%" }}
      >
        <defs>
          <linearGradient id="horizonGlow" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ff5a2e" stopOpacity="0.12" />
            <stop offset="100%" stopColor="#ff5a2e" stopOpacity="0" />
          </linearGradient>
          <radialGradient id="bossGlow">
            <stop offset="0%" stopColor="#ff5a8a" stopOpacity="0.85" />
            <stop offset="100%" stopColor="#ff5a8a" stopOpacity="0" />
          </radialGradient>
          {/* Soft, cheap glow used sparingly on hero elements (ship, boss, ufo). */}
          <filter id="softGlow" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="0.7" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Faint horizon line above the player lane */}
        <line
          x1="0"
          y1={PLAYER_Y + 4}
          x2={FIELD_W}
          y2={PLAYER_Y + 4}
          stroke="#ff8a3d"
          strokeOpacity="0.22"
          strokeWidth="0.22"
        />
        <rect
          x="0"
          y={PLAYER_Y + 4}
          width={FIELD_W}
          height={100 - (PLAYER_Y + 4)}
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
                      opacity={0.5}
                    />
                  ) : null,
                ),
              )}
            </g>
          );
        })}

        {/* Player bullets — glowing rounded shots with a faint trail */}
        {live.bullets.map((b) => {
          const color = b.pierce ? "#ffe066" : "#fff5e0";
          return (
            <g key={b.id}>
              <rect
                x={b.x - 0.5}
                y={b.y - 2.4}
                width="1"
                height="3.6"
                rx="0.5"
                fill={color}
                opacity={0.18}
              />
              <rect x={b.x - 0.22} y={b.y - 1.8} width="0.44" height="2.6" rx="0.22" fill={color} />
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
              opacity={0.16}
            />
            <rect x={b.x - 0.26} y={b.y - 1.2} width="0.52" height="2.4" rx="0.26" fill="#ff6b3d" />
          </g>
        ))}

        {/* Enemies — refined envelopes with a subtle colored halo */}
        {live.enemies.map((e) => {
          if (!e.alive) return null;
          const offset = e.kind === "phishing" ? Math.sin(e.zig) * 2 : 0;
          const ex = live.formationX + e.col * COL_GAP + offset;
          const ey = live.formationY + e.row * ROW_GAP;
          const flashing = e.hitUntil > now;
          const colors = ENEMY_COLORS[e.kind];
          const bodyFill = flashing ? "#fff5e0" : colors.body;
          return (
            <g key={e.id} transform={`translate(${ex} ${ey})`}>
              {/* halo */}
              <rect
                x={-ENEMY_HALF_W - 0.5}
                y={-ENEMY_HALF_H - 0.5}
                width={ENEMY_HALF_W * 2 + 1}
                height={ENEMY_HALF_H * 2 + 1}
                rx="0.9"
                fill={colors.accent}
                opacity={flashing ? 0.35 : 0.12}
              />
              <rect
                x={-ENEMY_HALF_W}
                y={-ENEMY_HALF_H}
                width={ENEMY_HALF_W * 2}
                height={ENEMY_HALF_H * 2}
                rx="0.5"
                fill={bodyFill}
                stroke={colors.accent}
                strokeWidth="0.22"
              />
              <path
                d={`M ${-ENEMY_HALF_W} ${-ENEMY_HALF_H} L 0 ${-ENEMY_HALF_H + 1.7} L ${ENEMY_HALF_W} ${-ENEMY_HALF_H}`}
                fill="none"
                stroke={colors.accent}
                strokeWidth="0.22"
                strokeLinejoin="round"
              />
              <line
                x1={-ENEMY_HALF_W + 0.6}
                y1={ENEMY_HALF_H - 1.1}
                x2={ENEMY_HALF_W - 0.6}
                y2={ENEMY_HALF_H - 1.1}
                stroke={colors.accent}
                strokeOpacity="0.5"
                strokeWidth="0.14"
              />
              <rect
                x={ENEMY_HALF_W - 1.2}
                y={-ENEMY_HALF_H + 0.3}
                width="0.85"
                height="0.85"
                rx="0.15"
                fill={colors.stamp}
              />
              {e.kind === "urgent" && (
                <text
                  x="0"
                  y={ENEMY_HALF_H - 1.3}
                  textAnchor="middle"
                  fontFamily="JetBrains Mono, monospace"
                  fontSize="1.3"
                  fontWeight="700"
                  fill={colors.stamp}
                >
                  !
                </text>
              )}
            </g>
          );
        })}

        {/* Boss */}
        {live.boss && (
          <g transform={`translate(${live.boss.x} ${live.boss.y})`}>
            <circle r="7" fill="url(#bossGlow)" />
            <g filter="url(#softGlow)">
              <rect
                x="-5"
                y="-3.5"
                width="10"
                height="7"
                rx="0.8"
                fill="#3a0d12"
                stroke="#ff5a8a"
                strokeWidth="0.3"
              />
              <path
                d="M -5 -3.5 L 0 0.5 L 5 -3.5"
                fill="none"
                stroke="#ff5a8a"
                strokeWidth="0.3"
                strokeLinejoin="round"
              />
              <rect x="-5" y="2" width="10" height="0.8" rx="0.2" fill="#ffd400" />
              <text
                x="0"
                y="0.4"
                textAnchor="middle"
                fontFamily="JetBrains Mono, monospace"
                fontSize="1.6"
                fontWeight="700"
                fill="#ffd400"
              >
                SPAM
              </text>
            </g>
            <rect
              x="-6"
              y="-5.5"
              width="12"
              height="0.6"
              rx="0.3"
              fill="#3a0d12"
              stroke="#ff5a8a"
              strokeWidth="0.1"
            />
            <rect
              x="-6"
              y="-5.5"
              width={12 * Math.max(0, live.boss.hp / live.boss.maxHp)}
              height="0.6"
              rx="0.3"
              fill="#ff5a8a"
            />
          </g>
        )}

        {/* UFO */}
        {live.ufo && (
          <g transform={`translate(${live.ufo.x} ${live.ufo.y})`} filter="url(#softGlow)">
            <ellipse cx="0" cy="0" rx="3.2" ry="1" fill="#ffe066" />
            <ellipse cx="0" cy="-0.4" rx="1.6" ry="0.6" fill="#fff5e0" />
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
        )}

        {/* Powerups */}
        {live.powerups.map((p) => {
          const color = POWERUP_COLORS[p.kind];
          return (
            <g key={p.id} transform={`translate(${p.x} ${p.y})`}>
              <rect
                x="-1.9"
                y="-1.4"
                width="3.8"
                height="2.8"
                rx="1.3"
                fill={color}
                opacity="0.14"
              />
              <rect
                x="-1.6"
                y="-1.2"
                width="3.2"
                height="2.4"
                rx="1.1"
                fill="#0a0e1a"
                stroke={color}
                strokeWidth="0.22"
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
              x={p.x - 0.22}
              y={p.y - 0.22}
              width="0.44"
              height="0.44"
              rx="0.22"
              fill={p.color}
              opacity={a}
            />
          );
        })}

        {/* Bursts — eased expanding ring with a bright core */}
        {live.bursts.map((b) => {
          const t = Math.min(1, (now - b.startedAt) / BURST_MS);
          const eased = 1 - (1 - t) * (1 - t);
          const scale = b.big ? 1.8 : 1;
          const r = (2 + eased * 8) * scale;
          const fade = 1 - t;
          return (
            <g key={b.id} transform={`translate(${b.x} ${b.y})`}>
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
                opacity={fade * 0.7}
              />
              <circle r={1.3 * fade * scale} fill="#fff5e0" opacity={fade} />
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
            {/* soft engine glow */}
            <ellipse cx="0" cy="0.5" rx="2.6" ry="3.6" fill="#ff8a3d" opacity="0.12" />
            {isMovingHint && (
              <polygon points="-0.8,3 0.8,3 0,5.8" fill="#ff8a3d" className="thruster" />
            )}
            <image
              href={shipUrl}
              x={-SHIP_W / 2}
              y={-5.2}
              width={SHIP_W}
              height={SHIP_H}
              preserveAspectRatio="xMidYMid meet"
              filter="url(#softGlow)"
            />
            {live.shieldUntil > now && (
              <circle
                r="6"
                fill="none"
                stroke="#7cc4ff"
                strokeWidth="0.4"
                opacity={0.55 + 0.45 * Math.sin(now / 80)}
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
