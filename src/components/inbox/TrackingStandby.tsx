import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getInvaderStats, submitInvaderScore, type InvaderStats } from "@/lib/invader.functions";
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

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#02030a]">
      <style>{`
        @keyframes thruster { 0%,100%{transform:scaleY(.7);opacity:.6} 50%{transform:scaleY(1.2);opacity:1} }
        .thruster { transform-origin:center top; animation: thruster .12s linear infinite; }
        @keyframes invuln { 0%,100%{opacity:.25} 50%{opacity:1} }
        .invuln { animation: invuln .12s linear infinite; }
        @keyframes zerrow-star-drift { from{transform:translateY(-6px)} to{transform:translateY(6px)} }
        .zerrow-stars-back { animation: zerrow-star-drift 14s ease-in-out infinite alternate; }
        .zerrow-stars-front { animation: zerrow-star-drift 9s ease-in-out infinite alternate; }
        .zerrow-star { position:absolute; border-radius:9999px; background:#dfe7ff; }
      `}</style>

      {/* Clean space backdrop: subtle radial vignette + parallax starfield */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(120% 90% at 50% 8%, rgba(255,138,61,0.05), transparent 55%), radial-gradient(120% 120% at 50% 120%, rgba(124,196,255,0.04), transparent 60%)",
        }}
        aria-hidden="true"
      >
        <div className="zerrow-stars-back absolute inset-0">
          {STARS_BACK.map((s, i) => (
            <span
              key={`sb-${i}`}
              className="zerrow-star"
              style={{ left: s.l, top: s.t, width: 1.5, height: 1.5, opacity: 0.35 }}
            />
          ))}
        </div>
        <div className="zerrow-stars-front absolute inset-0">
          {STARS_FRONT.map((s, i) => (
            <span
              key={`sf-${i}`}
              className="zerrow-star"
              style={{ left: s.l, top: s.t, width: 2, height: 2, opacity: 0.55 }}
            />
          ))}
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

      {/* Full-bleed gameplay area */}
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
