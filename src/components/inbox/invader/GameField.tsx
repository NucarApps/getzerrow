import { memo, useEffect, useReducer, useRef } from "react";
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

  // Ship aspect-ratio compensation; ResizeObserver writes to a ref (no re-render).
  const sizeRef = useRef({ w: 0, h: 0 });
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      sizeRef.current = { w: el.clientWidth, h: el.clientHeight };
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [containerRef]);

  return (
    <div
      ref={containerRef}
      className="pointer-events-auto relative h-full w-full max-w-[900px] max-h-full overflow-hidden"
      style={{ aspectRatio: "4 / 3", transform: `translate(${dx}px, ${dy}px)` }}
      tabIndex={0}
    >
      <svg
        className="absolute inset-0 z-10"
        viewBox="0 0 100 100"
        preserveAspectRatio="xMidYMid meet"
        style={{ width: "100%", height: "100%" }}
      >
        <defs>
          <linearGradient id="horizonGlow" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ff5a2e" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#ff5a2e" stopOpacity="0" />
          </linearGradient>
          <radialGradient id="bossGlow">
            <stop offset="0%" stopColor="#ff5a8a" stopOpacity="0.9" />
            <stop offset="100%" stopColor="#ff5a8a" stopOpacity="0" />
          </radialGradient>
        </defs>

        <line x1="0" y1={PLAYER_Y + 4} x2="100" y2={PLAYER_Y + 4} stroke="#ff8a3d" strokeOpacity="0.35" strokeWidth="0.3" />
        <rect x="0" y={PLAYER_Y + 4} width="100" height={100 - (PLAYER_Y + 4)} fill="url(#horizonGlow)" />

        {/* Bunkers */}
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
                      x={left + c * BUNKER_CELL}
                      y={top + r * BUNKER_CELL}
                      width={BUNKER_CELL}
                      height={BUNKER_CELL}
                      fill="#67ffb8"
                      opacity={0.6}
                    />
                  ) : null,
                ),
              )}
            </g>
          );
        })}

        {/* Player bullets */}
        {live.bullets.map((b) => (
          <rect key={b.id} x={b.x - 0.25} y={b.y - 1.6} width="0.5" height="2.4" fill={b.pierce ? "#ffe066" : "#fff5e0"} />
        ))}

        {/* Enemy bullets */}
        {live.enemyBullets.map((b) => (
          <rect key={b.id} x={b.x - 0.3} y={b.y - 1.2} width="0.6" height="2.4" fill="#ff5a2e" />
        ))}

        {/* Enemies */}
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
              <rect x={-ENEMY_HALF_W} y={-ENEMY_HALF_H} width={ENEMY_HALF_W * 2} height={ENEMY_HALF_H * 2} rx="0.35" fill={bodyFill} stroke={colors.accent} strokeWidth="0.18" />
              <path
                d={`M ${-ENEMY_HALF_W} ${-ENEMY_HALF_H} L 0 ${-ENEMY_HALF_H + 1.7} L ${ENEMY_HALF_W} ${-ENEMY_HALF_H}`}
                fill="none"
                stroke={colors.accent}
                strokeWidth="0.18"
              />
              <line x1={-ENEMY_HALF_W + 0.6} y1={ENEMY_HALF_H - 1.1} x2={ENEMY_HALF_W - 0.6} y2={ENEMY_HALF_H - 1.1} stroke={colors.accent} strokeOpacity="0.55" strokeWidth="0.14" />
              <rect x={ENEMY_HALF_W - 1.2} y={-ENEMY_HALF_H + 0.3} width="0.85" height="0.85" fill={colors.stamp} />
              {e.kind === "urgent" && (
                <text x="0" y={ENEMY_HALF_H - 1.3} textAnchor="middle" fontFamily="JetBrains Mono, monospace" fontSize="1.3" fontWeight="700" fill={colors.stamp}>!</text>
              )}
            </g>
          );
        })}

        {/* Boss */}
        {live.boss && (
          <g transform={`translate(${live.boss.x} ${live.boss.y})`}>
            <circle r="6.5" fill="url(#bossGlow)" />
            <rect x="-5" y="-3.5" width="10" height="7" rx="0.6" fill="#3a0d12" stroke="#ff5a8a" strokeWidth="0.3" />
            <path d="M -5 -3.5 L 0 0.5 L 5 -3.5" fill="none" stroke="#ff5a8a" strokeWidth="0.3" />
            <rect x="-5" y="2" width="10" height="0.8" fill="#ffd400" />
            <text x="0" y="0.4" textAnchor="middle" fontFamily="JetBrains Mono, monospace" fontSize="1.6" fontWeight="700" fill="#ffd400">SPAM</text>
            <rect x="-6" y="-5.5" width="12" height="0.6" fill="#3a0d12" stroke="#ff5a8a" strokeWidth="0.1" />
            <rect x="-6" y="-5.5" width={12 * Math.max(0, live.boss.hp / live.boss.maxHp)} height="0.6" fill="#ff5a8a" />
          </g>
        )}

        {/* UFO */}
        {live.ufo && (
          <g transform={`translate(${live.ufo.x} ${live.ufo.y})`}>
            <ellipse cx="0" cy="0" rx="3.2" ry="1" fill="#ffe066" />
            <ellipse cx="0" cy="-0.4" rx="1.6" ry="0.6" fill="#fff5e0" />
            <text x="0" y="0.5" textAnchor="middle" fontFamily="JetBrains Mono, monospace" fontSize="0.9" fontWeight="700" fill="#3a0d12">VIP</text>
          </g>
        )}

        {/* Powerups */}
        {live.powerups.map((p) => {
          const color = POWERUP_COLORS[p.kind];
          return (
            <g key={p.id} transform={`translate(${p.x} ${p.y})`}>
              <rect x="-1.6" y="-1.2" width="3.2" height="2.4" rx="1.1" fill="#0a0e1a" stroke={color} strokeWidth="0.22" />
              <text x="0" y="0.55" textAnchor="middle" fontFamily="JetBrains Mono, monospace" fontWeight="700" fontSize="1.8" fill={color}>{POWERUP_LABEL[p.kind]}</text>
            </g>
          );
        })}

        {/* Particles */}
        {live.particles.map((p) => {
          const a = 1 - p.life / p.ttl;
          return <rect key={p.id} x={p.x - 0.2} y={p.y - 0.2} width="0.4" height="0.4" fill={p.color} opacity={a} />;
        })}

        {/* Bursts */}
        {live.bursts.map((b) => {
          const age = (now - b.startedAt) / BURST_MS;
          const scale = b.big ? 1.8 : 1;
          const RINGS = 6;
          return (
            <g key={b.id} transform={`translate(${b.x} ${b.y})`}>
              {Array.from({ length: RINGS }).map((_, i) => {
                const a = (i / RINGS) * Math.PI * 2;
                const r = (3 + age * 4) * scale;
                return <circle key={i} cx={Math.cos(a) * r} cy={Math.sin(a) * r} r={0.55 * scale} fill="#ff8a3d" opacity={1 - age} />;
              })}
              <circle r={1 * scale} fill="#fff5e0" opacity={1 - age} />
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
          <g transform={`translate(${live.playerX} ${PLAYER_Y})`} className={now < invulnUntil ? "invuln" : undefined}>
            {isMovingHint && <polygon points="-0.8,3 0.8,3 0,5.5" fill="#ff8a3d" className="thruster" />}
            {(() => {
              const SHIP_SRC_RATIO = 187 / 265;
              const shipH = 9;
              const size = sizeRef.current;
              const stretch = size.h > 0 ? size.w / size.h : 1;
              const shipW = stretch > 0 ? (shipH * SHIP_SRC_RATIO) / stretch : 7;
              return (
                <image
                  href={shipUrl}
                  x={-shipW / 2}
                  y={-5.2}
                  width={shipW}
                  height={shipH}
                  preserveAspectRatio="xMidYMid meet"
                />
              );
            })()}
            {live.shieldUntil > now && (
              <circle r="6" fill="none" stroke="#7cc4ff" strokeWidth="0.4" opacity={0.55 + 0.45 * Math.sin(now / 80)} />
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
