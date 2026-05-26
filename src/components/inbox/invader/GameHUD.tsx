import { POWERUP_COLORS, POWERUP_NAME } from "@/lib/invader/engine";
import type { GameState } from "@/lib/invader/useInvaderGame";

type Props = {
  state: GameState;
  difficultyLabel: string;
  muted: boolean;
  dailyMode: boolean;
};

export function GameHUD({ state, difficultyLabel, muted, dailyMode }: Props) {
  const now = performance.now();
  const buffRemaining = state.activeBuff ? Math.max(0, (state.activeBuff.expiresAt - now) / 1000) : 0;
  const lives = Math.max(0, state.lives);

  return (
    <>
      <div
        className="pointer-events-none absolute left-1/2 top-3 z-20 -translate-x-1/2 rounded-sm border border-[rgba(255,138,61,.35)] bg-[rgba(10,14,26,.65)] px-3 py-1 text-[10px] tracking-[0.22em] text-[#ffd089] backdrop-blur"
        style={{ fontFamily: "JetBrains Mono, ui-monospace, monospace" }}
      >
        LEVEL {String(state.level).padStart(2, "0")} · SCORE {String(state.score).padStart(5, "0")} · {"♥".repeat(lives)}{"♡".repeat(Math.max(0, 3 - lives))}
        {state.combo > 1 && (
          <span className="ml-2 text-[#ffe066]">×{state.combo}</span>
        )}
      </div>

      <div
        className="pointer-events-none absolute right-3 top-3 z-20 flex flex-col items-end gap-1 text-[9px] tracking-[0.22em] text-muted-foreground/70"
        style={{ fontFamily: "JetBrains Mono, ui-monospace, monospace" }}
      >
        <span>{difficultyLabel}{dailyMode ? " · DAILY" : ""}{muted ? " · MUTED" : ""}</span>
        {state.maxCombo > 1 && <span>BEST COMBO ×{state.maxCombo}</span>}
      </div>

      {state.activeBuff && (
        <div
          className="pointer-events-none absolute left-1/2 top-9 z-20 -translate-x-1/2 rounded-sm border px-2 py-0.5 text-[10px] tracking-[0.22em] backdrop-blur"
          style={{
            fontFamily: "JetBrains Mono, ui-monospace, monospace",
            color: POWERUP_COLORS[state.activeBuff.kind],
            borderColor: POWERUP_COLORS[state.activeBuff.kind] + "66",
            background: "rgba(10,14,26,.65)",
          }}
        >
          {POWERUP_NAME[state.activeBuff.kind]} · {buffRemaining.toFixed(1)}s
        </div>
      )}
    </>
  );
}
