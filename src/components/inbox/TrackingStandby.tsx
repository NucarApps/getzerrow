import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  getInvaderStats,
  submitInvaderScore,
  type InvaderStats,
} from "@/lib/invader.functions";
import { useInvaderGame } from "@/lib/invader/useInvaderGame";
import { DIFFICULTY } from "@/lib/invader/engine";
import { GameField } from "@/components/inbox/invader/GameField";
import { GameHUD } from "@/components/inbox/invader/GameHUD";
import { GameOverlay } from "@/components/inbox/invader/GameOverlay";

/**
 * Inbox empty state — Space Invaders mini-game.
 * Player ship defends against incoming "email" enemies (newsletter / urgent /
 * attachment / phishing), boss waves every 5 levels, UFOs, bunkers, power-ups,
 * combo multiplier, screen shake, daily challenges, and achievements.
 */
export function TrackingStandby() {
  // ---- Background telemetry HUD (decorative) ----
  const epoch = useRef(Date.now());
  const apogeeRef = useRef(0);
  const [t, setT] = useState({ downrange: 0, apogee: 0, pitch: 90, alt: 0, vel: 0 });
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Game ----
  const {
    state,
    settings,
    setSettings,
    setKey,
    start,
    togglePause,
    containerRef,
    consumeFinishedRun,
    getLive,
    subscribe,
  } = useInvaderGame();

  // ---- Leaderboard / score submission ----
  const queryClient = useQueryClient();
  const fetchStats = useServerFn(getInvaderStats);
  const submitScore = useServerFn(submitInvaderScore);
  const { data: stats } = useQuery<InvaderStats>({
    queryKey: ["invader-stats"],
    queryFn: () => fetchStats(),
    staleTime: 30_000,
  });
  type SubmitPayload = {
    score: number;
    level: number;
    kills: number;
    maxCombo: number;
    durationMs: number;
    dailySeed: string | null;
    achievements: string[];
  };
  const submitMutation = useMutation({
    mutationFn: (payload: SubmitPayload) => submitScore({ data: payload }),
    onSuccess: (next) => {
      queryClient.setQueryData(["invader-stats"], next);
    },
  });
  const submittedForGameRef = useRef(false);
  useEffect(() => {
    if (state.phase === "playing") submittedForGameRef.current = false;
    if (state.phase === "over" && !submittedForGameRef.current) {
      const finished = consumeFinishedRun();
      if (finished && finished.score > 0) {
        submittedForGameRef.current = true;
        submitMutation.mutate(finished);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase]);

  // ---- Share score ----
  const shareScore = () => {
    const text = `I scored ${state.score} pts on Zerrow Invader Defense (lvl ${state.level}, ×${state.maxCombo} combo). Beat me at https://getzerrow.com`;
    const nav = window.navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
    if (nav.share) {
      nav.share({ title: "Zerrow Invader Defense", text }).catch(() => undefined);
    } else if (nav.clipboard?.writeText) {
      nav.clipboard.writeText(text);
    }
  };

  const now = performance.now();
  const isMoving = state.phase === "playing"; // simpler than tracking key state from outside the hook

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#02030a]">
      <style>{`
        @keyframes thruster { 0%,100%{transform:scaleY(.7);opacity:.6} 50%{transform:scaleY(1.2);opacity:1} }
        .thruster { transform-origin:center top; animation: thruster .12s linear infinite; }
        @keyframes invuln { 0%,100%{opacity:.25} 50%{opacity:1} }
        .invuln { animation: invuln .12s linear infinite; }
        @keyframes powerup-bob { 0%,100%{transform:translateY(-.4px)} 50%{transform:translateY(.4px)} }
        .powerup { animation: powerup-bob 1.1s ease-in-out infinite; }
        @keyframes star-drift { from{transform:translateY(0)} to{transform:translateY(8px)} }
        .star-layer { animation: star-drift 6s linear infinite alternate; }
      `}</style>

      {/* Tracking HUD frame */}
      <div className="launchpad__viewport is-tracking" style={{ position: "absolute", inset: 0, minHeight: 0 }}>
        <div className="tracking" aria-hidden="true" style={{ opacity: 1 }}>
          <div className="tracking__sky star-layer">
            <i style={{ left: "8%", top: "18%" }}></i>
            <i style={{ left: "22%", top: "42%" }}></i>
            <i style={{ left: "34%", top: "12%" }}></i>
            <i style={{ left: "47%", top: "28%" }}></i>
            <i style={{ left: "58%", top: "8%" }}></i>
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
              <div className="attitude__needle" style={{ transform: `translate(-50%, -100%) rotate(${90 - t.pitch}deg)` }}></div>
            </div>
            <div className="tele-row"><span className="k">Pitch</span><span className="v orange">{t.pitch.toFixed(0)}°</span></div>
          </div>
        </div>
      </div>

      <GameHUD
        level={state.level}
        score={state.score}
        lives={state.lives}
        combo={state.combo}
        maxCombo={state.maxCombo}
        activeBuff={state.activeBuff}
        difficultyLabel={DIFFICULTY[settings.difficulty].label}
        muted={settings.muted}
        dailyMode={settings.dailyMode}
      />

      {/* Pause button (top-left) */}
      {state.phase === "playing" && (
        <button
          type="button"
          onClick={togglePause}
          className="pointer-events-auto absolute left-3 top-3 z-20 rounded-sm border border-[rgba(255,138,61,.35)] bg-[rgba(10,14,26,.65)] px-2 py-0.5 text-[10px] tracking-[0.22em] text-[#ffd089]"
          style={{ fontFamily: "JetBrains Mono, ui-monospace, monospace" }}
          aria-label="Pause"
        >
          ‖
        </button>
      )}

      {/* Centered, constrained gameplay area */}
      <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
        <GameField
          getLive={getLive}
          subscribe={subscribe}
          containerRef={containerRef}
          phase={state.phase}
          lives={state.lives}
          isMovingHint={state.phase === "playing"}
        />
      </div>

      {/* Overlays */}
      {state.phase !== "playing" && (
        <GameOverlay
          phase={state.phase}
          state={state}
          stats={stats}
          settings={settings}
          setSettings={setSettings}
          onStart={start}
          shareScore={shareScore}
          shareDisabled={state.score <= 0}
        />
      )}

      {/* Touch controls (mobile) */}
      <div className="pointer-events-auto absolute inset-x-0 bottom-2 z-20 hidden items-center justify-center gap-3 px-4 [@media(pointer:coarse)]:flex">
        <button
          aria-label="Left"
          onPointerDown={() => setKey("left", true)}
          onPointerUp={() => setKey("left", false)}
          onPointerCancel={() => setKey("left", false)}
          onPointerLeave={() => setKey("left", false)}
          className="select-none rounded-md border border-[rgba(255,138,61,.4)] bg-[rgba(10,14,26,.7)] px-5 py-3 text-lg text-[#ffd089]"
        >
          ◀
        </button>
        <button
          aria-label="Fire"
          onPointerDown={() => setKey("fire", true)}
          onPointerUp={() => setKey("fire", false)}
          onPointerCancel={() => setKey("fire", false)}
          onPointerLeave={() => setKey("fire", false)}
          className="select-none rounded-md border border-[rgba(255,138,61,.4)] bg-[rgba(255,90,46,.18)] px-6 py-3 text-[#ffd089]"
          style={{ fontFamily: "JetBrains Mono, ui-monospace, monospace" }}
        >
          FIRE
        </button>
        <button
          aria-label="Right"
          onPointerDown={() => setKey("right", true)}
          onPointerUp={() => setKey("right", false)}
          onPointerCancel={() => setKey("right", false)}
          onPointerLeave={() => setKey("right", false)}
          className="select-none rounded-md border border-[rgba(255,138,61,.4)] bg-[rgba(10,14,26,.7)] px-5 py-3 text-lg text-[#ffd089]"
        >
          ▶
        </button>
      </div>

      {state.phase === "playing" && (
        <div className="pointer-events-none absolute inset-x-0 bottom-1 z-10 text-center text-[10px] tracking-[0.22em] text-muted-foreground/60">
          AWAITING PAYLOAD — SELECT A TRANSMISSION
        </div>
      )}
    </div>
  );
}
