import { memo, useMemo, useState } from "react";
import {
  ACHIEVEMENTS,
  type AchievementKey,
  type GameSettings,
  loadAchievements,
} from "@/lib/invader/storage";
import { DIFFICULTY } from "@/lib/invader/engine";
import type { GameState, Phase } from "@/lib/invader/useInvaderGame";
import type { InvaderStats } from "@/lib/invader.functions";

type Props = {
  phase: Phase;
  state: GameState;
  stats: InvaderStats | undefined;
  settings: GameSettings;
  setSettings: (s: GameSettings) => void;
  onStart: () => void;
  shareScore: () => void;
  shareDisabled: boolean;
};

function GameOverlayImpl({
  phase,
  state,
  stats,
  settings,
  setSettings,
  onStart,
  shareScore,
  shareDisabled,
}: Props) {
  // `phase` is an intentional refresh trigger: re-read unlocked achievements
  // from storage on each phase change (e.g. game-over) so newly-earned ones show.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const unlocked = useMemo<Set<AchievementKey>>(() => loadAchievements(), [phase]);
  const [tab, setTab] = useState<"global" | "daily" | "achievements">("global");

  return (
    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 bg-[rgba(2,3,10,0.62)] text-center backdrop-blur-sm">
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
        {phase === "over" && `Level ${state.level} · ${state.score} pts`}
      </div>
      {phase === "over" && (
        <div
          className="text-[10px] tracking-[0.22em] text-muted-foreground"
          style={{ fontFamily: "JetBrains Mono, ui-monospace, monospace" }}
        >
          KILLS {state.kills} · BEST COMBO ×{state.maxCombo} ·{" "}
          {(state.durationMs / 1000).toFixed(1)}s
        </div>
      )}

      <button
        type="button"
        onClick={onStart}
        className="mt-2 rounded-sm border border-[#ff8a3d] bg-[#ff5a2e]/20 px-4 py-1.5 text-[11px] tracking-[0.28em] text-[#ffd089] hover:bg-[#ff5a2e]/35"
        style={{ fontFamily: "JetBrains Mono, ui-monospace, monospace" }}
      >
        {phase === "ready" && "LAUNCH"}
        {phase === "paused" && "RESUME"}
        {phase === "over" && "RESTART"}
      </button>

      {phase === "over" && (
        <button
          type="button"
          onClick={shareScore}
          disabled={shareDisabled}
          className="mt-1 rounded-sm border border-[rgba(255,138,61,.35)] px-3 py-1 text-[10px] tracking-[0.28em] text-[#ffd089]/85 hover:bg-[rgba(255,138,61,.1)] disabled:opacity-40"
          style={{ fontFamily: "JetBrains Mono, ui-monospace, monospace" }}
        >
          SHARE SCORE
        </button>
      )}

      {/* Settings row */}
      <div
        className="mt-3 flex flex-wrap items-center justify-center gap-2 text-[9px] tracking-[0.24em] text-[#ffd089]"
        style={{ fontFamily: "JetBrains Mono, ui-monospace, monospace" }}
      >
        {(Object.keys(DIFFICULTY) as Array<keyof typeof DIFFICULTY>).map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => setSettings({ ...settings, difficulty: d })}
            className={`rounded-sm border px-2 py-0.5 ${settings.difficulty === d ? "border-[#ff8a3d] bg-[#ff5a2e]/20" : "border-[rgba(255,138,61,.25)]"}`}
          >
            {DIFFICULTY[d].label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setSettings({ ...settings, dailyMode: !settings.dailyMode })}
          className={`rounded-sm border px-2 py-0.5 ${settings.dailyMode ? "border-[#67ffb8] bg-[#67ffb8]/15 text-[#67ffb8]" : "border-[rgba(255,138,61,.25)]"}`}
        >
          DAILY
        </button>
        <button
          type="button"
          onClick={() => setSettings({ ...settings, muted: !settings.muted })}
          className="rounded-sm border border-[rgba(255,138,61,.25)] px-2 py-0.5"
        >
          {settings.muted ? "MUTED" : "SOUND"}
        </button>
      </div>

      {/* Stats / leaderboards / achievements */}
      <div
        className="mt-4 w-full max-w-sm rounded-sm border border-[rgba(255,138,61,.25)] bg-[rgba(10,14,26,.55)] px-3 py-2 text-left"
        style={{ fontFamily: "JetBrains Mono, ui-monospace, monospace" }}
      >
        <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-center text-[9px] tracking-[0.22em] text-[#ffd089]">
          <span>BEST {stats?.myBest != null ? String(stats.myBest).padStart(5, "0") : "—"}</span>
          <span className="text-muted-foreground/50">·</span>
          <span>
            GLOBAL {stats?.globalBest != null ? String(stats.globalBest).padStart(5, "0") : "—"}
          </span>
          <span className="text-muted-foreground/50">·</span>
          <span>RANK {stats?.myRank != null ? `#${stats.myRank}` : "—"}</span>
        </div>
        <div className="mt-1 text-center text-[9px] tracking-[0.22em] text-muted-foreground/70">
          PLAYS {stats?.myPlays ?? 0} · KILLS {stats?.myKills ?? 0} · BEST COMBO ×
          {stats?.myBestCombo ?? 0}
        </div>

        <div className="mt-3 flex justify-center gap-2 text-[9px] tracking-[0.22em]">
          {(["global", "daily", "achievements"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`rounded-sm px-2 py-0.5 ${tab === t ? "bg-[rgba(255,138,61,.18)] text-[#ffd089]" : "text-muted-foreground/70"}`}
            >
              {t.toUpperCase()}
            </button>
          ))}
        </div>

        {tab === "global" && (
          <div className="mt-2 space-y-0.5 text-[10px] tracking-[0.18em] text-muted-foreground">
            {stats && stats.top5.length > 0 ? (
              stats.top5.map((row, i) => (
                <div key={`g-${i}`} className="flex items-center justify-between gap-2">
                  <span className="w-3 text-muted-foreground/60">{i + 1}</span>
                  <span className="flex-1 truncate uppercase">{row.name}</span>
                  <span className="tabular-nums text-[#ffd089]">
                    {String(row.score).padStart(5, "0")}
                  </span>
                </div>
              ))
            ) : (
              <div className="text-center text-[9px] tracking-[0.28em] text-muted-foreground/60">
                BE THE FIRST PILOT
              </div>
            )}
          </div>
        )}

        {tab === "daily" && (
          <div className="mt-2 space-y-0.5 text-[10px] tracking-[0.18em] text-muted-foreground">
            <div className="text-center text-[9px] tracking-[0.28em] text-muted-foreground/70">
              SEED {stats?.dailySeed ?? "—"} · MY BEST{" "}
              {stats?.myDailyBest != null ? String(stats.myDailyBest).padStart(5, "0") : "—"}
            </div>
            {stats && stats.dailyTop5 && stats.dailyTop5.length > 0 ? (
              stats.dailyTop5.map((row, i) => (
                <div key={`d-${i}`} className="flex items-center justify-between gap-2">
                  <span className="w-3 text-muted-foreground/60">{i + 1}</span>
                  <span className="flex-1 truncate uppercase">{row.name}</span>
                  <span className="tabular-nums text-[#ffd089]">
                    {String(row.score).padStart(5, "0")}
                  </span>
                </div>
              ))
            ) : (
              <div className="text-center text-[9px] tracking-[0.28em] text-muted-foreground/60">
                NO RUNS TODAY — ENABLE DAILY MODE
              </div>
            )}
          </div>
        )}

        {tab === "achievements" && (
          <div className="mt-2 space-y-1 text-[10px] tracking-[0.16em]">
            {ACHIEVEMENTS.map((a) => {
              const got = unlocked.has(a.key);
              return (
                <div key={a.key} className="flex items-start gap-2">
                  <span className={got ? "text-[#ffe066]" : "text-muted-foreground/40"}>★</span>
                  <div className="flex-1">
                    <div
                      className={
                        got ? "uppercase text-[#ffd089]" : "uppercase text-muted-foreground/60"
                      }
                    >
                      {a.name}
                    </div>
                    <div className="text-[9px] text-muted-foreground/60">{a.description}</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div
        className="mt-3 text-[10px] tracking-[0.28em] text-muted-foreground/70"
        style={{ fontFamily: "JetBrains Mono, ui-monospace, monospace" }}
      >
        ← → MOVE · SPACE FIRE · P PAUSE · M MUTE
      </div>
    </div>
  );
}

export const GameOverlay = memo(GameOverlayImpl);
