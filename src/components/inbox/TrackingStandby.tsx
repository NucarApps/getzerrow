import { useEffect, useRef, useState, useCallback } from "react";

/**
 * Inbox empty state — Space Invaders mini-game.
 * The rocket is the player; alien email envelopes descend in waves;
 * arrow keys move, space fires. Telemetry HUD chips and starfield
 * remain as cosmic backdrop.
 */

type Bullet = { id: number; x: number; y: number };
type Enemy = { id: number; col: number; row: number; alive: boolean; hitUntil: number };
type Burst = { id: number; x: number; y: number; startedAt: number };

const FIELD_W = 100;
const FIELD_H = 100;
const PLAYER_Y = 90;
const PLAYER_SPEED = 55;          // units / sec
const BULLET_SPEED = 95;
const ENEMY_BULLET_BASE = 38;
const BURST_MS = 600;
const PLAYER_FIRE_COOLDOWN = 280; // ms
const FORMATION_TOP = 14;
const ROW_GAP = 8;
const COL_GAP = 10;
const ENEMY_R = 3.2;               // collision radius
const PLAYER_HALF_W = 3.2;
const INVULN_MS = 900;

function spawnWave(level: number): Enemy[] {
  const rows = Math.min(5, 3 + Math.floor(level / 2));
  const cols = Math.min(8, 5 + Math.floor(level / 3));
  const enemies: Enemy[] = [];
  let id = 1;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      enemies.push({ id: id++, col: c, row: r, alive: true, hitUntil: 0 });
    }
  }
  return enemies;
}

function formationBounds(enemies: Enemy[], originX: number, originY: number) {
  let minX = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const e of enemies) {
    if (!e.alive) continue;
    const x = originX + e.col * COL_GAP;
    const y = originY + e.row * ROW_GAP;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, maxX, maxY, anyAlive: minX !== Infinity };
}

export function TrackingStandby() {
  const epoch = useRef(Date.now());
  const apogeeRef = useRef(0);
  const [t, setT] = useState({ downrange: 0, apogee: 0, pitch: 90, alt: 0, vel: 0 });

  const containerRef = useRef<HTMLDivElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const reducedMotionRef = useRef(false);
  const idRef = useRef(1);

  // HUD-relevant React state
  const [score, setScore] = useState(0);
  const [lives, setLives] = useState(3);
  const [level, setLevel] = useState(1);
  const [phase, setPhase] = useState<"ready" | "playing" | "paused" | "over">("ready");
  const phaseRef = useRef(phase);
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  // Per-frame mutable game state
  const playerXRef = useRef(50);
  const playerCooldownRef = useRef(0);
  const invulnUntilRef = useRef(0);
  const keysRef = useRef<{ left: boolean; right: boolean; fire: boolean }>({ left: false, right: false, fire: false });
  const bulletsRef = useRef<Bullet[]>([]);
  const enemyBulletsRef = useRef<Bullet[]>([]);
  const enemiesRef = useRef<Enemy[]>(spawnWave(1));
  const burstsRef = useRef<Burst[]>([]);
  // Formation origin + direction
  const formationXRef = useRef(10);          // x of leftmost-col enemy
  const formationYRef = useRef(FORMATION_TOP);
  const marchDirRef = useRef<1 | -1>(1);
  const marchSpeedRef = useRef(6);
  const levelRef = useRef(1);
  const stepBlipAtRef = useRef(0);
  const flapTickRef = useRef(0);
  const [flap, setFlap] = useState(0); // forces re-render for wing-flap

  // Force re-render at ~30fps for HUD visuals that don't change React state.
  const [, setFrameTick] = useState(0);

  // Telemetry tick (unchanged)
  useEffect(() => {
    const LIFT_DURATION = 22;
    const tick = () => {
      const launchT = (Date.now() - epoch.current) / 1000;
      let alt: number;
      let vel: number;
      if (launchT < LIFT_DURATION) {
        const f = launchT / LIFT_DURATION;
        alt = +(120 * Math.pow(f, 1.8)).toFixed(1);
        vel = Math.round(2400 * Math.pow(f, 1.4));
      } else {
        alt = +(t.alt + Math.random() * 0.12).toFixed(1);
        vel = t.vel + Math.floor((Math.random() - 0.5) * 2);
      }
      if (alt > apogeeRef.current) apogeeRef.current = alt;
      const sinceLift = Math.max(0, launchT - LIFT_DURATION);
      const downrange = Math.max(0, Math.round((vel * sinceLift) / 1000));
      const pitch = Math.max(25, 90 - Math.min(65, sinceLift * 1.2));
      setT({ downrange, apogee: apogeeRef.current, pitch, alt, vel });
    };
    tick();
    const id = window.setInterval(tick, 600);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedMotionRef.current = mq.matches;
    const onChange = () => { reducedMotionRef.current = mq.matches; };
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  // Audio helpers
  const ensureAudio = useCallback(() => {
    if (reducedMotionRef.current) return null;
    if (!audioCtxRef.current) {
      const Ctor = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
      if (!Ctor) return null;
      audioCtxRef.current = new Ctor();
    }
    if (audioCtxRef.current?.state === "suspended") audioCtxRef.current.resume();
    return audioCtxRef.current;
  }, []);
  const playPew = useCallback(() => {
    const ctx = ensureAudio(); if (!ctx) return;
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.type = "sine"; const t0 = ctx.currentTime;
    o.frequency.setValueAtTime(880, t0);
    o.frequency.exponentialRampToValueAtTime(220, t0 + 0.08);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.04, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.09);
    o.connect(g).connect(ctx.destination); o.start(t0); o.stop(t0 + 0.1);
  }, [ensureAudio]);
  const playBoom = useCallback(() => {
    const ctx = ensureAudio(); if (!ctx) return;
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.type = "triangle"; const t0 = ctx.currentTime;
    o.frequency.setValueAtTime(180, t0);
    o.frequency.exponentialRampToValueAtTime(60, t0 + 0.22);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.07, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.28);
    o.connect(g).connect(ctx.destination); o.start(t0); o.stop(t0 + 0.3);
  }, [ensureAudio]);
  const playStep = useCallback(() => {
    const ctx = ensureAudio(); if (!ctx) return;
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.type = "square"; const t0 = ctx.currentTime;
    o.frequency.setValueAtTime(80, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.025, t0 + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.06);
    o.connect(g).connect(ctx.destination); o.start(t0); o.stop(t0 + 0.07);
  }, [ensureAudio]);

  const resetGame = useCallback(() => {
    levelRef.current = 1;
    enemiesRef.current = spawnWave(1);
    bulletsRef.current = [];
    enemyBulletsRef.current = [];
    burstsRef.current = [];
    formationXRef.current = 10;
    formationYRef.current = FORMATION_TOP;
    marchDirRef.current = 1;
    marchSpeedRef.current = 6;
    playerXRef.current = 50;
    playerCooldownRef.current = 0;
    invulnUntilRef.current = 0;
    setScore(0);
    setLives(3);
    setLevel(1);
  }, []);

  // Keyboard
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const k = e.key;
      const isGameKey = ["ArrowLeft", "ArrowRight", "ArrowUp", "a", "A", "d", "D", "w", "W", " ", "p", "P", "Enter"].includes(k);
      if (!isGameKey) return;
      e.preventDefault();
      ensureAudio();

      if (k === "ArrowLeft" || k === "a" || k === "A") keysRef.current.left = true;
      if (k === "ArrowRight" || k === "d" || k === "D") keysRef.current.right = true;
      if (k === " " || k === "ArrowUp" || k === "w" || k === "W") keysRef.current.fire = true;

      if (k === " " || k === "Enter") {
        if (phaseRef.current === "ready") setPhase("playing");
        else if (phaseRef.current === "over") { resetGame(); setPhase("playing"); }
      }
      if (k === "p" || k === "P") {
        if (phaseRef.current === "playing") setPhase("paused");
        else if (phaseRef.current === "paused") setPhase("playing");
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const k = e.key;
      if (k === "ArrowLeft" || k === "a" || k === "A") keysRef.current.left = false;
      if (k === "ArrowRight" || k === "d" || k === "D") keysRef.current.right = false;
      if (k === " " || k === "ArrowUp" || k === "w" || k === "W") keysRef.current.fire = false;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [ensureAudio, resetGame]);

  // Game RAF loop
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(64, now - last);
      last = now;

      if (reducedMotionRef.current) {
        raf = requestAnimationFrame(loop);
        return;
      }
      if (phaseRef.current !== "playing") {
        raf = requestAnimationFrame(loop);
        // still tick re-render so overlays update
        if (now - flapTickRef.current > 250) { flapTickRef.current = now; setFrameTick((x) => (x + 1) % 1_000_000); }
        return;
      }

      const dts = dt / 1000;

      // Player movement
      let px = playerXRef.current;
      if (keysRef.current.left) px -= PLAYER_SPEED * dts;
      if (keysRef.current.right) px += PLAYER_SPEED * dts;
      if (px < 6) px = 6; if (px > 94) px = 94;
      playerXRef.current = px;

      // Player firing
      playerCooldownRef.current = Math.max(0, playerCooldownRef.current - dt);
      if (keysRef.current.fire && playerCooldownRef.current === 0) {
        bulletsRef.current.push({ id: idRef.current++, x: px, y: PLAYER_Y - 4 });
        playerCooldownRef.current = PLAYER_FIRE_COOLDOWN;
        playPew();
      }

      // Move player bullets up
      bulletsRef.current = bulletsRef.current
        .map((b) => ({ ...b, y: b.y - BULLET_SPEED * dts }))
        .filter((b) => b.y > -2);

      // Enemy formation march
      const bounds = formationBounds(enemiesRef.current, formationXRef.current, formationYRef.current);
      if (!bounds.anyAlive) {
        // wave clear
        const nextLvl = levelRef.current + 1;
        levelRef.current = nextLvl;
        setLevel(nextLvl);
        setScore((s) => s + 50);
        enemiesRef.current = spawnWave(nextLvl);
        formationXRef.current = 10;
        formationYRef.current = FORMATION_TOP;
        marchDirRef.current = 1;
        marchSpeedRef.current = Math.min(30, 6 + nextLvl * 1.8);
        bulletsRef.current = [];
        enemyBulletsRef.current = [];
      } else {
        const dir = marchDirRef.current;
        let nextX = formationXRef.current + dir * marchSpeedRef.current * dts;
        const nextBounds = formationBounds(enemiesRef.current, nextX, formationYRef.current);
        if (nextBounds.minX < 4 || nextBounds.maxX > 96) {
          // Drop a row and reverse
          marchDirRef.current = (dir === 1 ? -1 : 1);
          formationYRef.current += 4 + Math.min(levelRef.current, 6);
          marchSpeedRef.current = Math.min(30, marchSpeedRef.current * 1.15);
          // clamp x so formation doesn't escape
          if (nextBounds.minX < 4) nextX = formationXRef.current + (4 - nextBounds.minX);
          if (nextBounds.maxX > 96) nextX = formationXRef.current - (nextBounds.maxX - 96);
        }
        formationXRef.current = nextX;
        // step blip cadence ~ tied to speed
        const stepInterval = Math.max(180, 700 - marchSpeedRef.current * 18);
        if (now - stepBlipAtRef.current > stepInterval) {
          stepBlipAtRef.current = now;
          playStep();
        }
      }

      // Enemy firing
      const lvl = levelRef.current;
      const fireChance = Math.min(2.5, 0.35 + lvl * 0.18) * dts;
      if (Math.random() < fireChance) {
        const live = enemiesRef.current.filter((e) => e.alive);
        if (live.length > 0) {
          const shooter = live[Math.floor(Math.random() * live.length)];
          const ex = formationXRef.current + shooter.col * COL_GAP;
          const ey = formationYRef.current + shooter.row * ROW_GAP;
          enemyBulletsRef.current.push({ id: idRef.current++, x: ex, y: ey + 2 });
        }
      }

      // Move enemy bullets down
      const eBulletSpeed = Math.min(70, ENEMY_BULLET_BASE + lvl * 3);
      enemyBulletsRef.current = enemyBulletsRef.current
        .map((b) => ({ ...b, y: b.y + eBulletSpeed * dts }))
        .filter((b) => b.y < FIELD_H + 2);

      // Collisions: player bullets vs enemies
      const remainingBullets: Bullet[] = [];
      for (const b of bulletsRef.current) {
        let hit = false;
        for (const e of enemiesRef.current) {
          if (!e.alive) continue;
          const ex = formationXRef.current + e.col * COL_GAP;
          const ey = formationYRef.current + e.row * ROW_GAP;
          const dx = b.x - ex, dy = b.y - ey;
          if (dx * dx + dy * dy < ENEMY_R * ENEMY_R) {
            e.alive = false;
            hit = true;
            burstsRef.current.push({ id: idRef.current++, x: ex, y: ey, startedAt: now });
            setScore((s) => s + 10 * lvl);
            playBoom();
            break;
          }
        }
        if (!hit) remainingBullets.push(b);
      }
      bulletsRef.current = remainingBullets;

      // Collisions: enemy bullets vs player
      const safeBullets: Bullet[] = [];
      const isInvuln = now < invulnUntilRef.current;
      for (const b of enemyBulletsRef.current) {
        const dx = b.x - px;
        const dy = b.y - PLAYER_Y;
        if (!isInvuln && Math.abs(dx) < PLAYER_HALF_W && Math.abs(dy) < 3.5) {
          burstsRef.current.push({ id: idRef.current++, x: px, y: PLAYER_Y, startedAt: now });
          playBoom();
          invulnUntilRef.current = now + INVULN_MS;
          setLives((l) => {
            const nl = l - 1;
            if (nl <= 0) setPhase("over");
            return nl;
          });
        } else {
          safeBullets.push(b);
        }
      }
      enemyBulletsRef.current = safeBullets;

      // Formation reached player?
      if (bounds.maxY >= PLAYER_Y - 4) {
        setPhase("over");
      }

      // Prune bursts
      burstsRef.current = burstsRef.current.filter((b) => now - b.startedAt < BURST_MS);

      // Wing flap toggle
      if (now - flapTickRef.current > 500) {
        flapTickRef.current = now;
        setFlap((f) => (f + 1) % 2);
      }

      setFrameTick((x) => (x + 1) % 1_000_000);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playPew, playBoom, playStep]);

  const startOrRestart = () => {
    ensureAudio();
    if (phase === "ready") setPhase("playing");
    else if (phase === "over") { resetGame(); setPhase("playing"); }
    else if (phase === "paused") setPhase("playing");
  };

  // Touch chip handlers
  const holdKey = (key: "left" | "right" | "fire", val: boolean) => () => {
    keysRef.current[key] = val;
  };

  const now = performance.now();

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden bg-[#02030a]" tabIndex={0}>
      <style>{`
        @keyframes thruster { 0%,100%{transform:scaleY(.7);opacity:.6} 50%{transform:scaleY(1.2);opacity:1} }
        .thruster { transform-origin:center top; animation: thruster .12s linear infinite; }
        @keyframes invuln { 0%,100%{opacity:.25} 50%{opacity:1} }
        .invuln { animation: invuln .12s linear infinite; }
        .alien { transition: transform .08s linear; }
      `}</style>

      <div
        className="launchpad__viewport is-tracking"
        style={{ position: "absolute", inset: 0, minHeight: 0 }}
      >
        <div className="tracking" aria-hidden="true" style={{ opacity: 1 }}>
          <div className="tracking__sky">
            <i style={{ left: "8%",  top: "18%" }}></i>
            <i style={{ left: "22%", top: "42%" }}></i>
            <i style={{ left: "34%", top: "12%" }}></i>
            <i style={{ left: "47%", top: "28%" }}></i>
            <i style={{ left: "58%", top: "8%"  }}></i>
            <i style={{ left: "66%", top: "36%" }}></i>
            <i style={{ left: "74%", top: "20%" }}></i>
            <i style={{ left: "86%", top: "32%" }}></i>
            <i style={{ left: "92%", top: "14%" }}></i>
            <i style={{ left: "14%", top: "60%" }}></i>
          </div>

          <div className="tracking__hud tracking__hud--tl">
            <span className="tracking__dot"></span>
            TRACKING · DOWNRANGE
          </div>
          <div className="tracking__hud tracking__hud--br">
            <div className="tele-row"><span className="k">Downrange</span><span className="v orange">{t.downrange.toLocaleString("en-US")} km</span></div>
            <div className="tele-row"><span className="k">Apogee</span><span className="v">{t.apogee.toFixed(1)} km</span></div>
          </div>
          <div className="tracking__hud tracking__hud--tr">
            <div className="attitude">
              <svg viewBox="0 0 40 40" className="attitude__ring">
                <circle cx="20" cy="20" r="17" fill="none" stroke="rgba(255,138,61,.35)" strokeWidth="1" />
                <line x1="3" y1="20" x2="37" y2="20" stroke="rgba(255,138,61,.25)" strokeWidth="1" strokeDasharray="2 2" />
              </svg>
              <div
                className="attitude__needle"
                style={{ transform: `translate(-50%, -100%) rotate(${90 - t.pitch}deg)` }}
              ></div>
            </div>
            <div className="tele-row"><span className="k">Pitch</span><span className="v orange">{t.pitch.toFixed(0)}°</span></div>
          </div>
        </div>
      </div>

      {/* Score HUD */}
      <div
        className="pointer-events-none absolute left-1/2 top-3 z-20 -translate-x-1/2 rounded-sm border border-[rgba(255,138,61,.35)] bg-[rgba(10,14,26,.65)] px-3 py-1 text-[10px] tracking-[0.22em] text-[#ffd089] backdrop-blur"
        style={{ fontFamily: "JetBrains Mono, ui-monospace, monospace" }}
      >
        LEVEL {String(level).padStart(2, "0")} · SCORE {String(score).padStart(5, "0")} · {"♥".repeat(Math.max(0, lives))}{"♡".repeat(Math.max(0, 3 - lives))}
      </div>

      {/* Game layer */}
      <svg
        className="absolute inset-0 z-10"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        style={{ width: "100%", height: "100%" }}
      >
        {/* Ground line */}
        <line x1="0" y1={PLAYER_Y + 4} x2="100" y2={PLAYER_Y + 4} stroke="#ff8a3d" strokeOpacity="0.35" strokeWidth="0.3" />
        <rect x="0" y={PLAYER_Y + 4} width="100" height={100 - (PLAYER_Y + 4)} fill="url(#horizonGlow)" />
        <defs>
          <linearGradient id="horizonGlow" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ff5a2e" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#ff5a2e" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Player bullets */}
        {bulletsRef.current.map((b) => (
          <rect key={b.id} x={b.x - 0.25} y={b.y - 1.6} width="0.5" height="2.4" fill="#fff5e0" />
        ))}

        {/* Enemy bullets */}
        {enemyBulletsRef.current.map((b) => (
          <rect key={b.id} x={b.x - 0.3} y={b.y - 1.2} width="0.6" height="2.4" fill="#ff5a2e" />
        ))}

        {/* Enemies */}
        {enemiesRef.current.map((e) => {
          if (!e.alive) return null;
          const ex = formationXRef.current + e.col * COL_GAP;
          const ey = formationYRef.current + e.row * ROW_GAP;
          const flapY = flap === 0 ? 0 : -0.6;
          return (
            <g key={e.id} className="alien" transform={`translate(${ex} ${ey + flapY})`}>
              <ellipse cx="0" cy="0" rx="3" ry="1.3" fill="#ff8a3d" opacity="0.3" />
              <g transform="scale(0.055)">
                <rect x="-24" y="-14" width="48" height="28" rx="3" fill="#1a1f2e" stroke="#ff8a3d" strokeWidth="2" />
                <path d="M -24 -14 L 0 6 L 24 -14" fill="none" stroke="#ff8a3d" strokeWidth="2" />
                <line x1="0" y1="-14" x2="0" y2="-22" stroke="#ff8a3d" strokeWidth="1.5" />
                <circle cx="0" cy="-23" r="2" fill="#ffd089" />
              </g>
            </g>
          );
        })}

        {/* Bursts */}
        {burstsRef.current.map((b) => {
          const age = (now - b.startedAt) / BURST_MS;
          return (
            <g key={b.id} transform={`translate(${b.x} ${b.y})`}>
              {Array.from({ length: 8 }).map((_, i) => {
                const a = (i / 8) * Math.PI * 2;
                const r = 3 + age * 4;
                return (
                  <circle
                    key={i}
                    cx={Math.cos(a) * r}
                    cy={Math.sin(a) * r}
                    r="0.55"
                    fill="#ff8a3d"
                    opacity={1 - age}
                  />
                );
              })}
              <circle r="1" fill="#fff5e0" opacity={1 - age} />
            </g>
          );
        })}

        {/* Player rocket */}
        {(phase !== "over" || lives > 0) && (
          <g
            transform={`translate(${playerXRef.current} ${PLAYER_Y})`}
            className={now < invulnUntilRef.current ? "invuln" : undefined}
          >
            {/* thruster */}
            {(keysRef.current.left || keysRef.current.right) && (
              <polygon points="-0.8,3 0.8,3 0,5.5" fill="#ff8a3d" className="thruster" />
            )}
            {/* rocket body (pointed up) */}
            <g transform="scale(0.045) translate(-60, -110)">
              <path d="M60 6 L90 210 L60 210 Z" fill="#ff5a2e" />
              <path d="M60 6 L30 210 L60 210 Z" fill="#b8341a" />
              <path d="M42 150 L12 226 L42 218 Z" fill="#ff5a2e" />
              <path d="M42 150 L42 218 L34 226 Z" fill="#8a2a14" />
              <path d="M78 150 L108 226 L78 218 Z" fill="#ff5a2e" />
              <path d="M78 150 L78 218 L86 226 Z" fill="#b8341a" />
              <path d="M48 200 L72 200 L60 230 Z" fill="#0a0e1a" />
            </g>
          </g>
        )}
      </svg>

      {/* Overlays */}
      {phase !== "playing" && (
        <button
          type="button"
          onClick={startOrRestart}
          className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 bg-[rgba(2,3,10,0.55)] text-center backdrop-blur-sm focus:outline-none"
        >
          <div
            className="text-[11px] tracking-[0.32em] text-[#ffd089]"
            style={{ fontFamily: "JetBrains Mono, ui-monospace, monospace" }}
          >
            {phase === "ready" && "READY"}
            {phase === "paused" && "PAUSED"}
            {phase === "over" && "GAME OVER"}
          </div>
          <div className="font-display text-3xl text-foreground md:text-4xl">
            {phase === "ready" && "Invader Defense"}
            {phase === "paused" && "Standby"}
            {phase === "over" && `Level ${level} · ${score} pts`}
          </div>
          <div
            className="mt-1 text-[10px] tracking-[0.28em] text-muted-foreground"
            style={{ fontFamily: "JetBrains Mono, ui-monospace, monospace" }}
          >
            {phase === "ready" && "PRESS SPACE OR ENTER TO LAUNCH"}
            {phase === "paused" && "PRESS P TO RESUME"}
            {phase === "over" && "PRESS ENTER OR TAP TO RESTART"}
          </div>
          <div
            className="mt-3 text-[10px] tracking-[0.28em] text-muted-foreground/70"
            style={{ fontFamily: "JetBrains Mono, ui-monospace, monospace" }}
          >
            ← → MOVE   ·   SPACE FIRE   ·   P PAUSE
          </div>
        </button>
      )}

      {/* Touch fallback chips (coarse pointer only) */}
      <div
        className="pointer-events-auto absolute inset-x-0 bottom-2 z-20 hidden items-center justify-center gap-3 px-4 [@media(pointer:coarse)]:flex"
      >
        <button
          aria-label="Left"
          onTouchStart={holdKey("left", true)}
          onTouchEnd={holdKey("left", false)}
          onPointerDown={holdKey("left", true)}
          onPointerUp={holdKey("left", false)}
          className="rounded-md border border-[rgba(255,138,61,.4)] bg-[rgba(10,14,26,.7)] px-4 py-2 text-[#ffd089]"
        >◀</button>
        <button
          aria-label="Fire"
          onTouchStart={holdKey("fire", true)}
          onTouchEnd={holdKey("fire", false)}
          onPointerDown={holdKey("fire", true)}
          onPointerUp={holdKey("fire", false)}
          className="rounded-md border border-[rgba(255,138,61,.4)] bg-[rgba(255,90,46,.18)] px-5 py-2 text-[#ffd089]"
          style={{ fontFamily: "JetBrains Mono, ui-monospace, monospace" }}
        >FIRE</button>
        <button
          aria-label="Right"
          onTouchStart={holdKey("right", true)}
          onTouchEnd={holdKey("right", false)}
          onPointerDown={holdKey("right", true)}
          onPointerUp={holdKey("right", false)}
          className="rounded-md border border-[rgba(255,138,61,.4)] bg-[rgba(10,14,26,.7)] px-4 py-2 text-[#ffd089]"
        >▶</button>
      </div>

      {phase === "playing" && (
        <div className="pointer-events-none absolute inset-x-0 bottom-1 z-10 text-center text-[10px] tracking-[0.22em] text-muted-foreground/60">
          AWAITING PAYLOAD — SELECT A TRANSMISSION
        </div>
      )}
    </div>
  );
}
