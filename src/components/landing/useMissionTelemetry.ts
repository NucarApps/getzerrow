import { useEffect } from "react";

/**
 * Ported from telemetry.js. Drives the mission-control launchpad on the
 * landing page: inbox burn-down, rocket liftoff, MET clock, hero T-clock,
 * live altitude/velocity/etc, FAQ exclusivity.
 */
export function useMissionTelemetry() {
  useEffect(() => {
    const $ = (id: string) => document.getElementById(id);

    const counterEl = $("inbox-count");
    const deltaEl = $("inbox-delta");
    const rocketEl = $("rocket");
    const viewportEl = $("launchpad-viewport");
    const footRouted = $("foot-routed");
    const statRouted = $("stat-routed");
    let trackingTimeout = 0;
    let apogeeKm = 0;

    let routedToday = 142;
    const fmt = (n: number) => n.toLocaleString("en-US");

    // Inbox 1247 -> 0 over 8s, ease-out cubic
    let start: number | null = null;
    const DURATION = 8000;
    let rafId = 0;
    let currentPhase: "smoke" | "ignition" | "liftoff" | null = null;
    const setPhase = (next: "smoke" | "ignition" | "liftoff") => {
      if (!rocketEl || currentPhase === next) return;
      rocketEl.classList.remove("phase-smoke", "phase-ignition", "phase-liftoff");
      rocketEl.classList.add(`phase-${next}`);
      currentPhase = next;
    };
    const step = (ts: number) => {
      if (start === null) start = ts;
      const t = Math.min(1, (ts - start) / DURATION);
      const eased = 1 - Math.pow(1 - t, 3);
      const current = Math.round(1247 * (1 - eased));
      if (counterEl) counterEl.textContent = fmt(current);
      if (t < 0.4) setPhase("smoke");
      else if (t < 1) setPhase("ignition");
      if (t < 1) {
        rafId = requestAnimationFrame(step);
      } else {
        if (counterEl) {
          counterEl.textContent = "0";
          counterEl.classList.add("zero");
        }
        if (deltaEl) {
          deltaEl.textContent = "▲ INBOX ZERO";
          deltaEl.classList.add("zero");
        }
        setPhase("liftoff");
        trackingTimeout = window.setTimeout(() => {
          viewportEl?.classList.add("tracking");
        }, 1600);
      }
    };
    rafId = requestAnimationFrame(step);

    // MET clock + hero T-clock
    const metEl = $("met-val");
    const metEl2 = $("footer-met");
    const clockEl = $("hero-clock");
    const epoch = Date.now();
    let heroLaunch: number | null = null;
    const pad = (n: number, len = 2) => String(n).padStart(len, "0");
    const fmtTime = (secAbs: number) => {
      const h = Math.floor(secAbs / 3600);
      const m = Math.floor((secAbs % 3600) / 60);
      const s = Math.floor(secAbs % 60);
      return `${pad(h)}:${pad(m)}:${pad(s)}`;
    };
    const tick = () => {
      const elapsed = (Date.now() - epoch) / 1000;
      if (elapsed < 3 && clockEl) {
        const remain = 3 - elapsed;
        clockEl.textContent = `T-00:00:0${Math.ceil(remain)}`;
      } else if (clockEl) {
        if (heroLaunch === null) heroLaunch = elapsed;
        clockEl.textContent = `T+${fmtTime(elapsed - heroLaunch)}`;
      }
      const metStr = `T+${fmtTime(elapsed)}`;
      if (metEl) metEl.textContent = metStr;
      if (metEl2) metEl2.textContent = metStr;
    };
    tick();
    const tickInterval = window.setInterval(tick, 1000);

    // Live telemetry
    const tAlt = $("t-alt");
    const tVel = $("t-vel");
    const tThrust = $("t-thrust");
    const tFuel = $("t-fuel");
    const tG = $("t-g");
    const tHdg = $("t-hdg");
    const tDownrange = $("t-downrange");
    const tApogee = $("t-apogee");
    const footLat = $("foot-lat");
    const uplink = $("uplink-val");

    let alt = 0;
    let vel = 0;
    let thrust = 96.1;
    let fuel = 100;
    let g = 1.0;
    let hdg = 0;

    const updateTelemetry = () => {
      const elapsed = (Date.now() - epoch) / 1000;
      const launchT = Math.max(0, elapsed);
      if (launchT < 8) {
        const f = launchT / 8;
        alt = +(120 * Math.pow(f, 1.8)).toFixed(1);
        vel = Math.round(2400 * Math.pow(f, 1.4));
        g = +(1 + 2.2 * f).toFixed(1);
        hdg = +(launchT * 1.2).toFixed(1);
        thrust = +(96 + (Math.random() - 0.5) * 0.8).toFixed(1);
        fuel = Math.max(58, +(100 - launchT * 5.3).toFixed(1));
      } else {
        alt = +(alt + Math.random() * 0.4).toFixed(1);
        vel = vel + Math.floor((Math.random() - 0.5) * 6);
        g = +(2.1 + (Math.random() - 0.5) * 0.3).toFixed(1);
        hdg = +(hdg + (Math.random() - 0.5) * 0.4).toFixed(1);
        thrust = +(94 + (Math.random() - 0.5) * 1.2).toFixed(1);
        fuel = Math.max(20, +(fuel - 0.05).toFixed(1));
      }
      if (tAlt) tAlt.textContent = `${alt.toFixed(1)} km`;
      if (tVel) tVel.textContent = `${vel.toLocaleString("en-US")} m/s`;
      if (tThrust) tThrust.textContent = `${thrust.toFixed(1)}%`;
      if (tFuel) tFuel.textContent = `${fuel.toFixed(0)}%`;
      if (tG) tG.textContent = `${g.toFixed(1)} g`;
      if (tHdg) tHdg.textContent = `${hdg.toFixed(1)}°`;
      if (alt > apogeeKm) apogeeKm = alt;
      const downrange = Math.max(0, Math.round((vel * Math.max(0, launchT - 8)) / 1000));
      if (tDownrange) tDownrange.textContent = `${downrange.toLocaleString("en-US")} km`;
      if (tApogee) tApogee.textContent = `${apogeeKm.toFixed(1)} km`;
      if (footLat && footLat.firstChild) {
        const lat = (2.2 + Math.random() * 0.6).toFixed(1);
        footLat.firstChild.textContent = lat;
      }
      if (uplink) {
        uplink.textContent = (98 + Math.random() * 1.5).toFixed(1) + "%";
      }
      if (Math.random() < 0.18) {
        routedToday += 1;
        if (statRouted) statRouted.textContent = String(routedToday);
        if (footRouted) footRouted.textContent = String(routedToday);
      }
    };
    updateTelemetry();
    const teleInterval = window.setInterval(updateTelemetry, 220);

    // FAQ exclusivity
    const faqItems = Array.from(
      document.querySelectorAll<HTMLDetailsElement>(".faq-item"),
    );
    const onToggle = (d: HTMLDetailsElement) => () => {
      if (!d.open) return;
      faqItems.forEach((other) => {
        if (other !== d) other.open = false;
      });
    };
    const handlers = faqItems.map((d) => {
      const h = onToggle(d);
      d.addEventListener("toggle", h);
      return { d, h };
    });

    return () => {
      cancelAnimationFrame(rafId);
      clearInterval(tickInterval);
      clearInterval(teleInterval);
      handlers.forEach(({ d, h }) => d.removeEventListener("toggle", h));
    };
  }, []);
}
