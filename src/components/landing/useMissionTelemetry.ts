import { useEffect } from "react";

/**
 * Lightweight telemetry for the simplified landing page. Keeps the space theme
 * feeling alive with a single calm uptime clock, one dashboard counter that
 * settles, and single-open FAQ behavior. No launchpad animation.
 */
export function useMissionTelemetry() {
  useEffect(() => {
    const byId = (id: string) => document.getElementById(id);
    const pad = (n: number) => String(n).padStart(2, "0");
    const fmtTime = (secAbs: number) => {
      const h = Math.floor(secAbs / 3600);
      const m = Math.floor((secAbs % 3600) / 60);
      const s = Math.floor(secAbs % 60);
      return `${pad(h)}:${pad(m)}:${pad(s)}`;
    };

    // Uptime clock (status bar + footer)
    const metEl = byId("met-val");
    const metEl2 = byId("footer-met");
    const epoch = Date.now();
    const tick = () => {
      const metStr = `T+${fmtTime((Date.now() - epoch) / 1000)}`;
      if (metEl) metEl.textContent = metStr;
      if (metEl2) metEl2.textContent = metStr;
    };
    tick();
    const tickInterval = window.setInterval(tick, 1000);

    // Dashboard "messages sorted today" — a single gentle count-up that settles.
    const counterEl = byId("inbox-count");
    const target = 1248;
    let raf = 0;
    let startTs: number | null = null;
    const DURATION = 1600;
    const run = (ts: number) => {
      if (startTs === null) startTs = ts;
      const t = Math.min(1, (ts - startTs) / DURATION);
      const eased = 1 - Math.pow(1 - t, 3);
      if (counterEl) counterEl.textContent = Math.round(target * eased).toLocaleString("en-US");
      if (t < 1) raf = requestAnimationFrame(run);
    };
    raf = requestAnimationFrame(run);

    // FAQ: only one item open at a time
    const faqItems = Array.from(document.querySelectorAll<HTMLDetailsElement>(".faq-item"));
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
      clearInterval(tickInterval);
      cancelAnimationFrame(raf);
      handlers.forEach(({ d, h }) => d.removeEventListener("toggle", h));
    };
  }, []);
}
