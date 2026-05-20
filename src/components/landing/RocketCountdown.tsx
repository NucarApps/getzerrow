import { useEffect, useMemo, useState } from "react";

const GOLD = "#e0b54a";
const FG = "#f4f3ee";
const FG_MUTED = "#9a9aa8";
const BG_DEEP = "#0a0a12";

const sora = { fontFamily: "'Sora', ui-sans-serif, system-ui, sans-serif" };

// Countdown cycle: 5,4,3,2,1,0(LIFTOFF) — each step ~1s, hold liftoff 1.8s, then reset
const SEQUENCE = [5, 4, 3, 2, 1, 0];

export function RocketCountdown() {
  const [idx, setIdx] = useState(0);
  const [launching, setLaunching] = useState(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    if (launching) {
      timer = setTimeout(() => {
        setLaunching(false);
        setIdx(0);
      }, 2200);
    } else if (idx < SEQUENCE.length - 1) {
      timer = setTimeout(() => setIdx((i) => i + 1), 1000);
    } else {
      // reached 0
      timer = setTimeout(() => setLaunching(true), 600);
    }
    return () => clearTimeout(timer);
  }, [idx, launching]);

  const value = SEQUENCE[idx];

  const stars = useMemo(
    () =>
      Array.from({ length: 40 }, (_, i) => ({
        id: i,
        left: Math.random() * 100,
        top: Math.random() * 100,
        size: Math.random() * 1.6 + 0.6,
        delay: Math.random() * 3,
        dur: 2 + Math.random() * 3,
      })),
    [],
  );

  return (
    <div
      className="relative overflow-hidden rounded-3xl border"
      style={{
        background: `radial-gradient(ellipse at 50% 110%, rgba(224,181,74,0.18), transparent 60%), linear-gradient(180deg, ${BG_DEEP} 0%, #06060c 100%)`,
        borderColor: "#1c1c28",
        minHeight: 520,
      }}
    >
      <style>{`
        @keyframes zr-twinkle { 0%,100% { opacity: .15 } 50% { opacity: .9 } }
        @keyframes zr-flame { 0%,100% { transform: scaleY(1) scaleX(1); opacity: .9 } 50% { transform: scaleY(1.25) scaleX(.85); opacity: 1 } }
        @keyframes zr-flame-fast { 0%,100% { transform: scaleY(1) scaleX(1); opacity: 1 } 50% { transform: scaleY(1.6) scaleX(.7); opacity: .85 } }
        @keyframes zr-liftoff {
          0% { transform: translateY(0) }
          15% { transform: translate(-2px, 2px) }
          30% { transform: translate(2px, -1px) }
          45% { transform: translate(-2px, -8px) }
          100% { transform: translateY(-560px) }
        }
        @keyframes zr-shake {
          0%,100% { transform: translateX(0) }
          20% { transform: translateX(-2px) }
          40% { transform: translateX(3px) }
          60% { transform: translateX(-2px) }
          80% { transform: translateX(2px) }
        }
        @keyframes zr-pulse-glow {
          0%,100% { opacity: .35 } 50% { opacity: .75 }
        }
        @keyframes zr-smoke {
          0% { opacity: 0; transform: translateY(0) scale(.4) }
          25% { opacity: .8 }
          100% { opacity: 0; transform: translateY(120px) scale(2.4) }
        }
        @keyframes zr-liftoff-flame {
          0%,100% { transform: scaleY(2.2) scaleX(.85); opacity: 1 }
          50% { transform: scaleY(2.8) scaleX(.7); opacity: .9 }
        }
        @media (prefers-reduced-motion: reduce) {
          .zr-liftoff, .zr-shake, .zr-flame, .zr-flame-fast, .zr-twinkle, .zr-smoke { animation: none !important; }
        }
      `}</style>

      {/* Stars */}
      <div className="pointer-events-none absolute inset-0">
        {stars.map((s) => (
          <span
            key={s.id}
            className="zr-twinkle absolute rounded-full"
            style={{
              left: `${s.left}%`,
              top: `${s.top}%`,
              width: s.size,
              height: s.size,
              background: FG,
              animation: `zr-twinkle ${s.dur}s ease-in-out ${s.delay}s infinite`,
            }}
          />
        ))}
      </div>

      {/* Ground / launch pad */}
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 h-24"
        style={{
          background:
            "linear-gradient(180deg, transparent, rgba(224,181,74,0.07) 40%, rgba(224,181,74,0.18))",
        }}
      />
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 h-px"
        style={{ background: GOLD, opacity: 0.5 }}
      />

      {/* Countdown */}
      <div className="absolute left-0 right-0 top-8 z-10 flex flex-col items-center">
        <p
          className="text-[10px] uppercase tracking-[0.4em]"
          style={{ color: FG_MUTED, ...sora }}
        >
          {launching ? "Liftoff sequence" : "T-minus"}
        </p>
        <div
          className="mt-2 flex items-baseline gap-2 tabular-nums"
          style={{ ...sora }}
        >
          {launching ? (
            <span
              className="text-5xl font-bold md:text-6xl"
              style={{
                color: GOLD,
                letterSpacing: "0.08em",
                textShadow: `0 0 24px ${GOLD}`,
              }}
            >
              INBOX ZERO
            </span>
          ) : (
            <>
              <span className="text-2xl font-medium" style={{ color: FG_MUTED }}>
                T −
              </span>
              <span
                key={value}
                className="text-7xl font-bold md:text-8xl"
                style={{
                  color: value === 0 ? GOLD : FG,
                  textShadow:
                    value <= 1 ? `0 0 28px ${GOLD}` : "0 0 14px rgba(244,243,238,0.18)",
                  transition: "color .2s",
                }}
              >
                {value}
              </span>
            </>
          )}
        </div>
        <div className="mt-3 flex gap-1.5">
          {SEQUENCE.map((_, i) => (
            <span
              key={i}
              className="h-1 w-6 rounded-full transition-all"
              style={{
                background: i <= idx || launching ? GOLD : "#2a2a36",
                opacity: i <= idx || launching ? 1 : 0.6,
              }}
            />
          ))}
        </div>
      </div>

      {/* Glow at base */}
      <div
        className="pointer-events-none absolute left-1/2 bottom-12 -translate-x-1/2 rounded-full"
        style={{
          width: 260,
          height: 60,
          background: `radial-gradient(ellipse, ${GOLD} 0%, transparent 70%)`,
          opacity: launching ? 0 : 0.35,
          filter: "blur(8px)",
          animation: "zr-pulse-glow 2.4s ease-in-out infinite",
        }}
      />

      {/* Rocket + flame group */}
      <div
        className="absolute left-1/2 bottom-20 -translate-x-1/2"
        style={{
          animation: launching
            ? "zr-liftoff 2s cubic-bezier(.5,0,.6,1) forwards"
            : value <= 1
              ? "zr-shake .25s ease-in-out infinite"
              : "none",
        }}
      >
        {/* Smoke (only on liftoff) */}
        {launching && (
          <>
            {[0, 0.15, 0.3].map((d, i) => (
              <span
                key={i}
                className="absolute left-1/2 top-full -translate-x-1/2 rounded-full"
                style={{
                  width: 80,
                  height: 80,
                  background: "rgba(244,243,238,0.35)",
                  filter: "blur(10px)",
                  animation: `zr-smoke 1.6s ease-out ${d}s forwards`,
                }}
              />
            ))}
          </>
        )}

        {/* Rocket SVG */}
        <svg width="88" height="200" viewBox="0 0 88 200" fill="none">
          {/* Body */}
          <path
            d="M44 4 C58 22 64 50 64 96 L64 150 L24 150 L24 96 C24 50 30 22 44 4 Z"
            fill={FG}
            stroke={GOLD}
            strokeWidth="1.2"
          />
          {/* Window */}
          <circle cx="44" cy="70" r="9" fill={BG_DEEP} stroke={GOLD} strokeWidth="1.5" />
          <circle cx="41" cy="67" r="2.5" fill={GOLD} opacity="0.7" />
          {/* Body seam */}
          <line x1="44" y1="100" x2="44" y2="148" stroke={GOLD} strokeWidth="0.6" opacity="0.5" />
          {/* Fins */}
          <path d="M24 120 L8 156 L24 150 Z" fill={GOLD} />
          <path d="M64 120 L80 156 L64 150 Z" fill={GOLD} />
          {/* Nozzle */}
          <path d="M30 150 L58 150 L54 168 L34 168 Z" fill="#2a2a36" stroke={GOLD} strokeWidth="1" />
          {/* Z badge */}
          <text
            x="44"
            y="118"
            textAnchor="middle"
            fontFamily="Sora, sans-serif"
            fontSize="14"
            fontWeight="700"
            fill={GOLD}
          >
            Z
          </text>
        </svg>

        {/* Flame */}
        <div
          className="absolute left-1/2 -translate-x-1/2"
          style={{ top: 188, transformOrigin: "top center" }}
        >
          <div
            style={{
              width: 24,
              height: 60,
              background: `linear-gradient(180deg, ${GOLD} 0%, #ff7a1a 55%, transparent 100%)`,
              clipPath:
                "polygon(50% 100%, 0% 35%, 15% 0%, 50% 20%, 85% 0%, 100% 35%)",
              animation: launching
                ? "zr-liftoff-flame .18s ease-in-out infinite"
                : value <= 1
                  ? "zr-flame-fast .15s ease-in-out infinite"
                  : "zr-flame .35s ease-in-out infinite",
              filter: `drop-shadow(0 0 14px ${GOLD})`,
              transform: launching ? "scaleY(2.2)" : value <= 1 ? "scaleY(1.4)" : "scaleY(1)",
            }}
          />
        </div>
      </div>

      {/* Gantry */}
      <div
        className="pointer-events-none absolute bottom-20 left-[calc(50%-72px)] z-0 w-1"
        style={{ height: 130, background: "#2a2a36", opacity: launching ? 0.3 : 0.8 }}
      />
      <div
        className="pointer-events-none absolute bottom-20 right-[calc(50%-72px)] z-0 w-1"
        style={{ height: 130, background: "#2a2a36", opacity: launching ? 0.3 : 0.8 }}
      />

      {/* Caption */}
      <div className="absolute inset-x-0 bottom-4 z-10 text-center">
        <p className="text-[10px] uppercase tracking-[0.3em]" style={{ color: FG_MUTED, ...sora }}>
          142 messages routed · 0 unread
        </p>
      </div>
    </div>
  );
}
