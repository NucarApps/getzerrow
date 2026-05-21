import { useEffect, useRef, useState } from "react";

/**
 * Inbox empty state — same downrange tracking view used on the landing page
 * (post-liftoff). Self-contained: uses local state instead of DOM IDs, and
 * reuses the global `.tracking*` styles defined in public/zerrow-landing.css.
 */
export function TrackingStandby() {
  const epoch = useRef(Date.now());
  const apogeeRef = useRef(0);
  const [t, setT] = useState({
    downrange: 0,
    apogee: 0,
    pitch: 90,
    alt: 0,
    vel: 0,
  });

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

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#02030a]">
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
              <animateMotion dur="180s" repeatCount="indefinite" rotate="auto" calcMode="linear">
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
      <div className="pointer-events-none absolute inset-x-0 bottom-4 z-10 text-center text-[11px] tracking-[0.2em] text-muted-foreground">
        AWAITING PAYLOAD — SELECT A TRANSMISSION
      </div>
    </div>
  );
}
