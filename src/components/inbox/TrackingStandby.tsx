import { useEffect, useRef, useState, useCallback, PointerEvent as RPointerEvent } from "react";

/**
 * Inbox empty state — downrange tracking view with a tiny ambient mini-game.
 * Alien "email" ships drift across the sky; click to fire a laser, two hits
 * to neutralize. Telemetry + rocket arc remain as backdrop.
 */

type Ship = { id: number; x: number; y: number; vx: number; vy: number; hp: number; hitUntil: number; spawnedAt: number; lifespan: number };
type Laser = { id: number; fromX: number; fromY: number; toX: number; toY: number; startedAt: number };
type Burst = { id: number; x: number; y: number; startedAt: number };

const LASER_MS = 200;
const BURST_MS: number = 600;
const HIT_FLASH_MS = 140;
const MAX_SHIPS = 3;

export function TrackingStandby() {
  const epoch = useRef(Date.now());
  const apogeeRef = useRef(0);
  const [t, setT] = useState({ downrange: 0, apogee: 0, pitch: 90, alt: 0, vel: 0 });

  const containerRef = useRef<HTMLDivElement | null>(null);
  const idRef = useRef(1);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const reducedMotionRef = useRef(false);
  const lastSpawnRef = useRef(0);
  const nextSpawnGapRef = useRef(3500);

  const [ships, setShips] = useState<Ship[]>([]);
  const [lasers, setLasers] = useState<Laser[]>([]);
  const [bursts, setBursts] = useState<Burst[]>([]);
  const [score, setScore] = useState(0);

  // Telemetry tick (unchanged cadence)
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

  // Detect reduced motion
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedMotionRef.current = mq.matches;
    const onChange = () => { reducedMotionRef.current = mq.matches; };
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  // Game RAF loop
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(64, now - last);
      last = now;

      // Spawn
      if (!reducedMotionRef.current) {
        if (now - lastSpawnRef.current > nextSpawnGapRef.current) {
          lastSpawnRef.current = now;
          nextSpawnGapRef.current = 3500 + Math.random() * 2500;
          setShips((cur) => {
            if (cur.length >= MAX_SHIPS) return cur;
            const dir: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
            const crossSec = 18 + Math.random() * 10; // 18–28s
            const speed = 100 / crossSec / 1000; // % per ms
            return [
              ...cur,
              {
                id: idRef.current++,
                y: 15 + Math.random() * 50, // 15–65%
                dir,
                x: dir === 1 ? -8 : 108,
                hp: 2,
                hitUntil: 0,
                speed,
              },
            ];
          });
        }
      }

      // Move ships, despawn off-screen
      setShips((cur) => {
        if (cur.length === 0) return cur;
        const next: Ship[] = [];
        for (const s of cur) {
          const nx = s.x + s.dir * s.speed * dt;
          if (nx < -12 || nx > 112) continue;
          next.push({ ...s, x: nx });
        }
        return next;
      });

      // Prune lasers + bursts
      setLasers((cur) => (cur.length === 0 ? cur : cur.filter((l) => now - l.startedAt < LASER_MS)));
      setBursts((cur) => (cur.length === 0 ? cur : cur.filter((b) => now - b.startedAt < BURST_MS)));

      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const playPew = useCallback(() => {
    if (reducedMotionRef.current) return;
    try {
      if (!audioCtxRef.current) {
        const Ctor = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
        if (!Ctor) return;
        audioCtxRef.current = new Ctor();
      }
      const ctx = audioCtxRef.current;
      if (!ctx) return;
      if (ctx.state === "suspended") ctx.resume();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      const t0 = ctx.currentTime;
      o.frequency.setValueAtTime(880, t0);
      o.frequency.exponentialRampToValueAtTime(220, t0 + 0.08);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.05, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.09);
      o.connect(g).connect(ctx.destination);
      o.start(t0);
      o.stop(t0 + 0.1);
    } catch { /* ignore */ }
  }, []);

  const playBoom = useCallback(() => {
    if (reducedMotionRef.current) return;
    try {
      const ctx = audioCtxRef.current;
      if (!ctx) return;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "triangle";
      const t0 = ctx.currentTime;
      o.frequency.setValueAtTime(180, t0);
      o.frequency.exponentialRampToValueAtTime(60, t0 + 0.25);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.08, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.3);
      o.connect(g).connect(ctx.destination);
      o.start(t0);
      o.stop(t0 + 0.32);
    } catch { /* ignore */ }
  }, []);

  const handleShipClick = useCallback((e: RPointerEvent<SVGGElement>, shipId: number) => {
    e.stopPropagation();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = ((e.clientX - rect.left) / rect.width) * 100;
    const py = ((e.clientY - rect.top) / rect.height) * 100;
    const now = performance.now();

    setLasers((cur) => [
      ...cur,
      { id: idRef.current++, fromX: 50, fromY: 100, toX: px, toY: py, startedAt: now },
    ]);
    playPew();

    setShips((cur) => {
      const next: Ship[] = [];
      for (const s of cur) {
        if (s.id !== shipId) { next.push(s); continue; }
        const newHp = s.hp - 1;
        if (newHp <= 0) {
          setBursts((b) => [...b, { id: idRef.current++, x: s.x, y: s.y, startedAt: now }]);
          setScore((sc) => sc + 1);
          playBoom();
          continue;
        }
        next.push({ ...s, hp: newHp, hitUntil: now + HIT_FLASH_MS });
      }
      return next;
    });
  }, [playPew, playBoom]);

  const now = performance.now();

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden bg-[#02030a]">
      <style>{`
        @keyframes ufo-bob { 0%,100%{transform:translateY(-1px)} 50%{transform:translateY(2px)} }
        @keyframes ufo-glow { 0%,100%{opacity:.45} 50%{opacity:.85} }
        @keyframes laser-fade { 0%{opacity:1} 100%{opacity:0} }
        @keyframes burst-pop { 0%{transform:scale(.2);opacity:1} 100%{transform:scale(1.6);opacity:0} }
        .ufo-wrap { animation: ufo-bob 2.4s ease-in-out infinite; transform-origin:center; }
        .ufo-glow { animation: ufo-glow 1.8s ease-in-out infinite; }
        .laser-line { transform-origin: 0 0; animation: laser-fade ${LASER_MS}ms linear forwards; }
        .burst { animation: burst-pop ${BURST_MS}ms ease-out forwards; }
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
          <div className="tracking__earth"></div>
          <svg className="tracking__arc" viewBox="0 0 600 400" preserveAspectRatio="xMidYMid slice">
            <defs>
              <linearGradient id="arcGradStandby" x1="0" y1="1" x2="1" y2="0">
                <stop offset="0%" stopColor="#ff5a2e" stopOpacity=".15" />
                <stop offset="50%" stopColor="#ff8a3d" stopOpacity=".9" />
                <stop offset="100%" stopColor="#ffd089" stopOpacity=".4" />
              </linearGradient>
              <path id="arcPathStandby" d="M 30 370 Q 300 -120 570 90" />
            </defs>
            <use href="#arcPathStandby" className="tracking__arc-ghost" fill="none" />
            <use href="#arcPathStandby" className="tracking__arc-live tracking__arc-live--standby"  fill="none" stroke="url(#arcGradStandby)" />
            <g className="tracking__rocket">
              <g transform="rotate(90) scale(0.09) translate(-60 -118)">
                <path d="M60 6 L90 210 L60 210 Z" fill="#ff5a2e" />
                <path d="M60 6 L30 210 L60 210 Z" fill="#b8341a" />
                <path d="M42 150 L12 226 L42 218 Z" fill="#ff5a2e" />
                <path d="M42 150 L42 218 L34 226 Z" fill="#8a2a14" />
                <path d="M78 150 L108 226 L78 218 Z" fill="#ff5a2e" />
                <path d="M78 150 L78 218 L86 226 Z" fill="#b8341a" />
                <path d="M48 200 L72 200 L60 230 Z" fill="#0a0e1a" />
              </g>
              <animateMotion dur="420s" repeatCount="indefinite" rotate="auto" calcMode="linear">
                <mpath href="#arcPathStandby" />
              </animateMotion>
            </g>
          </svg>

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

      {/* Score HUD (top center) */}
      <div
        className="pointer-events-none absolute left-1/2 top-3 z-20 -translate-x-1/2 rounded-sm border border-[rgba(255,138,61,.35)] bg-[rgba(10,14,26,.6)] px-2.5 py-1 text-[10px] tracking-[0.22em] text-[#ffd089] backdrop-blur"
        style={{ fontFamily: "JetBrains Mono, ui-monospace, monospace" }}
      >
        INTRUDERS NEUTRALIZED · {String(score).padStart(3, "0")}
      </div>

      {/* Game layer */}
      <svg
        className="absolute inset-0 z-10"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        style={{ width: "100%", height: "100%" }}
      >
        {/* Lasers */}
        {lasers.map((l) => {
          const dx = l.toX - l.fromX;
          const dy = l.toY - l.fromY;
          const len = Math.hypot(dx, dy);
          const angle = Math.atan2(dy, dx) * (180 / Math.PI);
          return (
            <g key={l.id} transform={`translate(${l.fromX} ${l.fromY}) rotate(${angle})`} className="laser-line">
              <line x1="0" y1="0" x2={len} y2="0" stroke="#ff8a3d" strokeWidth="0.4" opacity="0.35" />
              <line x1="0" y1="0" x2={len} y2="0" stroke="#fff5e0" strokeWidth="0.15" />
            </g>
          );
        })}

        {/* Bursts */}
        {bursts.map((b) => {
          const age = (now - b.startedAt) / BURST_MS;
          return (
            <g key={b.id} transform={`translate(${b.x} ${b.y})`} className="burst">
              {Array.from({ length: 8 }).map((_, i) => {
                const a = (i / 8) * Math.PI * 2;
                const r = 4 + age * 3;
                return (
                  <circle
                    key={i}
                    cx={Math.cos(a) * r}
                    cy={Math.sin(a) * r}
                    r="0.6"
                    fill="#ff8a3d"
                  />
                );
              })}
              <circle r="1.2" fill="#fff5e0" />
            </g>
          );
        })}

        {/* Ships */}
        {ships.map((s) => {
          const flashing = s.hitUntil > now;
          return (
            <g
              key={s.id}
              transform={`translate(${s.x} ${s.y}) scale(${s.dir === -1 ? -1 : 1} 1)`}
              className="ufo-wrap"
              style={{ cursor: "crosshair", pointerEvents: "auto" }}
              onPointerDown={(e) => handleShipClick(e, s.id)}
            >
              {/* glow halo */}
              <ellipse cx="0" cy="0" rx="3.2" ry="1.4" fill="#ff8a3d" opacity={flashing ? 0.9 : 0.35} className="ufo-glow" />
              {/* envelope body */}
              <g transform="scale(0.06)">
                <rect x="-24" y="-14" width="48" height="28" rx="3" fill={flashing ? "#fff5e0" : "#1a1f2e"} stroke="#ff8a3d" strokeWidth="2" />
                <path d="M -24 -14 L 0 6 L 24 -14" fill="none" stroke="#ff8a3d" strokeWidth="2" />
                {/* tiny "alien" antenna */}
                <line x1="0" y1="-14" x2="0" y2="-22" stroke="#ff8a3d" strokeWidth="1.5" />
                <circle cx="0" cy="-23" r="2" fill="#ffd089" />
                {/* hp pip */}
                {s.hp === 2 && <circle cx="14" cy="-7" r="2" fill="#67ffb8" />}
                {s.hp === 1 && <circle cx="14" cy="-7" r="2" fill="#ef4444" />}
              </g>
            </g>
          );
        })}
      </svg>

      <div className="pointer-events-none absolute inset-x-0 bottom-4 z-10 text-center text-[11px] tracking-[0.2em] text-muted-foreground">
        AWAITING PAYLOAD — NEUTRALIZE INTRUDERS WHILE YOU WAIT
      </div>
    </div>
  );
}
