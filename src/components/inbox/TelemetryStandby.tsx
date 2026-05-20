import { useEffect, useRef, useState } from "react";

const pad = (n: number, len = 2) => String(n).padStart(len, "0");
const fmtTime = (sec: number) => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
};

export function TelemetryStandby() {
  const epoch = useRef(Date.now());
  const [met, setMet] = useState("T+00:00:00");
  const [tele, setTele] = useState({
    alt: 412.7,
    vel: 7842,
    thrust: 96.1,
    fuel: 78,
    g: 1.0,
    hdg: 87.3,
    uplink: 99.2,
  });

  useEffect(() => {
    const clockId = window.setInterval(() => {
      setMet(`T+${fmtTime((Date.now() - epoch.current) / 1000)}`);
    }, 1000);
    const teleId = window.setInterval(() => {
      setTele((prev) => ({
        alt: +(prev.alt + (Math.random() - 0.3) * 0.6).toFixed(1),
        vel: prev.vel + Math.floor((Math.random() - 0.5) * 12),
        thrust: +(95 + (Math.random() - 0.5) * 2.2).toFixed(1),
        fuel: Math.max(20, +(prev.fuel - 0.02).toFixed(1)),
        g: +(1 + (Math.random() - 0.5) * 0.4).toFixed(2),
        hdg: +(prev.hdg + (Math.random() - 0.5) * 0.5).toFixed(1),
        uplink: +(98 + Math.random() * 1.8).toFixed(1),
      }));
    }, 240);
    return () => {
      clearInterval(clockId);
      clearInterval(teleId);
    };
  }, []);

  const readouts: Array<[string, string]> = [
    ["ALT", `${tele.alt.toFixed(1)} km`],
    ["VEL", `${tele.vel.toLocaleString("en-US")} m/s`],
    ["THRUST", `${tele.thrust.toFixed(1)}%`],
    ["FUEL", `${tele.fuel.toFixed(0)}%`],
    ["G-FORCE", `${tele.g.toFixed(2)} g`],
    ["HDG", `${tele.hdg.toFixed(1)}°`],
  ];

  return (
    <div className="flex h-full w-full items-center justify-center p-6">
      <div
        className="relative w-full max-w-md overflow-hidden rounded-md border bg-card/60 p-5 font-mono text-xs"
        style={{
          backgroundImage:
            "linear-gradient(var(--border) 1px, transparent 1px), linear-gradient(90deg, var(--border) 1px, transparent 1px)",
          backgroundSize: "24px 24px",
          backgroundPosition: "center",
        }}
      >
        {/* corner glow */}
        <div
          className="pointer-events-none absolute -inset-px"
          style={{
            background:
              "radial-gradient(circle at 50% 100%, color-mix(in oklab, var(--primary) 18%, transparent), transparent 60%)",
          }}
        />

        {/* header */}
        <div className="relative flex items-center justify-between border-b pb-2">
          <div className="flex items-center gap-2">
            <span
              className="inline-block h-1.5 w-1.5 rounded-full bg-primary"
              style={{ animation: "pulse 1.4s ease-in-out infinite", boxShadow: "0 0 8px var(--primary)" }}
            />
            <span className="tracking-[0.18em] text-muted-foreground">
              TELEMETRY · STANDBY
            </span>
          </div>
          <span className="tabular-nums text-foreground/80">{met}</span>
        </div>

        {/* rocket trail */}
        <div className="relative my-5 flex h-24 items-end justify-center">
          <svg viewBox="0 0 40 80" className="h-24" aria-hidden>
            {/* trail */}
            <defs>
              <linearGradient id="trail" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.0" />
                <stop offset="100%" stopColor="var(--primary)" stopOpacity="0.55" />
              </linearGradient>
            </defs>
            <rect x="18" y="40" width="4" height="40" fill="url(#trail)">
              <animate attributeName="opacity" values="0.6;1;0.6" dur="1.2s" repeatCount="indefinite" />
            </rect>
            {/* rocket body */}
            <path
              d="M20 6 L26 22 L26 36 L14 36 L14 22 Z"
              fill="var(--foreground)"
              opacity="0.92"
            />
            <path d="M14 36 L8 42 L14 40 Z" fill="var(--muted-foreground)" />
            <path d="M26 36 L32 42 L26 40 Z" fill="var(--muted-foreground)" />
            <circle cx="20" cy="20" r="2.4" fill="var(--primary)" />
            {/* flame */}
            <path d="M16 40 L20 50 L24 40 Z" fill="var(--primary)">
              <animate attributeName="opacity" values="0.7;1;0.7" dur="0.4s" repeatCount="indefinite" />
            </path>
          </svg>
        </div>

        {/* readouts */}
        <div className="relative grid grid-cols-2 gap-px overflow-hidden rounded border bg-border">
          {readouts.map(([label, value]) => (
            <div key={label} className="flex items-center justify-between bg-card/80 px-3 py-2">
              <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
                {label}
              </span>
              <span className="tabular-nums text-foreground">{value}</span>
            </div>
          ))}
        </div>

        {/* uplink bar */}
        <div className="relative mt-4 flex items-center gap-3">
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
            UPLINK
          </span>
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-border">
            <div
              className="h-full bg-primary transition-all duration-200"
              style={{ width: `${tele.uplink}%`, boxShadow: "0 0 6px var(--primary)" }}
            />
          </div>
          <span className="tabular-nums text-foreground/80">{tele.uplink.toFixed(1)}%</span>
        </div>

        {/* footer */}
        <div className="relative mt-5 border-t pt-3 text-center text-[11px] tracking-[0.2em] text-muted-foreground">
          AWAITING PAYLOAD — SELECT A TRANSMISSION
        </div>
      </div>
    </div>
  );
}
