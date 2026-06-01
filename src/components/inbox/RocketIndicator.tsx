import zerrowShip from "@/assets/zerrow-ship.png";

export type RocketPhase = "idle" | "ready" | "launching" | "returning";

type Props = {
  pull: number; // 0..1+
  phase: RocketPhase;
};

export function RocketIndicator({ pull, phase }: Props) {
  const ready = phase === "ready";
  const launching = phase === "launching";
  const returning = phase === "returning";
  const visible = pull > 0 || launching || returning;

  let transform = "translateY(20px) scale(0.6) rotate(0deg)";
  let opacity = 0;
  let animation = "none";

  if (launching) {
    transform = "translateY(0) scale(1) rotate(0deg)";
    opacity = 1;
    animation = "rocket-blastoff 700ms cubic-bezier(0.5, 0, 0.75, 0) forwards";
  } else if (returning) {
    transform = "translateY(0) scale(1) rotate(0deg)";
    opacity = 1;
    animation = "rocket-return 600ms cubic-bezier(0.2, 0.8, 0.2, 1) forwards";
  } else if (visible) {
    const p = Math.min(1.2, pull);
    const ty = 24 - p * 24; // pulls up into view as you drag
    const sc = 0.55 + p * 0.45;
    transform = `translateY(${ty}px) scale(${sc})`;
    opacity = Math.min(1, 0.2 + p * 0.9);
    animation = ready ? "rocket-bob 1.2s ease-in-out infinite" : "none";
  }

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "flex-end",
        paddingBottom: 8,
      }}
    >
      <div
        style={{
          position: "relative",
          width: 56,
          height: 56,
          transform,
          opacity,
          animation,
          transition:
            launching || returning ? "none" : "transform 80ms linear, opacity 120ms linear",
          willChange: "transform, opacity",
        }}
      >
        {(launching || ready) && (
          <div
            aria-hidden
            style={{
              position: "absolute",
              left: "50%",
              top: "100%",
              transform: "translateX(-50%)",
              width: 14,
              height: launching ? 80 : 18,
              background:
                "linear-gradient(to bottom, rgba(255,180,80,0.95), rgba(255,90,40,0.6) 50%, rgba(255,90,40,0))",
              borderRadius: 8,
              filter: "blur(2px)",
              animation: launching
                ? "flame-flicker 80ms ease-in-out infinite alternate"
                : "flame-flicker 160ms ease-in-out infinite alternate",
            }}
          />
        )}
        <img
          src={zerrowShip}
          alt=""
          draggable={false}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "contain",
            filter: ready || launching ? "drop-shadow(0 0 10px rgba(255,140,80,0.6))" : "none",
          }}
        />
      </div>
      <span
        style={{
          marginTop: 4,
          fontSize: 10,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: "hsl(var(--muted-foreground))",
          opacity: launching || returning ? 0 : opacity * 0.9,
          transition: "opacity 120ms linear",
        }}
      >
        {launching ? "Launching" : ready ? "Release to refresh" : "Pull to refresh"}
      </span>
    </div>
  );
}
