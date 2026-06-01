import { useEffect, useRef, useState, type ReactNode, type MouseEventHandler } from "react";
import { RocketIndicator, type RocketPhase } from "./RocketIndicator";

const THRESHOLD = 72;
const MAX_PULL = 140;
const MIN_REFRESH_MS = 900;

type Props = {
  onRefresh: () => Promise<void> | void;
  children: ReactNode;
  className?: string;
  onClick?: MouseEventHandler<HTMLDivElement>;
};

export function PullToRefresh({ onRefresh, children, className, onClick }: Props) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const startYRef = useRef<number | null>(null);
  const pullingRef = useRef(false);
  const [pull, setPull] = useState(0);
  const [phase, setPhase] = useState<RocketPhase>("idle");

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;

    const onTouchStart = (e: TouchEvent) => {
      if (phase !== "idle" && phase !== "ready") return;
      if (el.scrollTop > 0) {
        startYRef.current = null;
        return;
      }
      startYRef.current = e.touches[0].clientY;
      pullingRef.current = false;
    };

    const onTouchMove = (e: TouchEvent) => {
      if (startYRef.current == null) return;
      if (phase === "launching" || phase === "returning") return;
      const dy = e.touches[0].clientY - startYRef.current;
      if (dy <= 0) {
        if (pullingRef.current) {
          pullingRef.current = false;
          setPull(0);
          setPhase("idle");
        }
        return;
      }
      // Engage once the user has clearly pulled down.
      if (!pullingRef.current && dy > 6) pullingRef.current = true;
      if (!pullingRef.current) return;
      e.preventDefault();
      // Resistance curve.
      const eased = Math.min(MAX_PULL, dy * 0.5);
      setPull(eased);
      setPhase(eased >= THRESHOLD ? "ready" : "idle");
    };

    const onTouchEnd = async () => {
      if (!pullingRef.current) {
        startYRef.current = null;
        return;
      }
      pullingRef.current = false;
      startYRef.current = null;
      if (pull >= THRESHOLD || phase === "ready") {
        setPhase("launching");
        setPull(0);
        const started = Date.now();
        try {
          await onRefresh();
        } catch {
          // swallow
        }
        const elapsed = Date.now() - started;
        if (elapsed < MIN_REFRESH_MS) {
          await new Promise((r) => setTimeout(r, MIN_REFRESH_MS - elapsed));
        }
        setPhase("idle");
      } else {
        setPull(0);
        setPhase("idle");
      }
    };

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);
    el.addEventListener("touchcancel", onTouchEnd);
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [phase, pull, onRefresh]);

  const indicatorHeight = phase === "launching" ? 96 : pull;

  return (
    <div
      ref={scrollerRef}
      className={className}
      onClick={onClick}
      style={{ overscrollBehaviorY: "contain", WebkitOverflowScrolling: "touch" }}
    >
      <div
        aria-hidden={phase === "idle" && pull === 0}
        style={{
          height: indicatorHeight,
          transition:
            pullingRef.current || phase === "launching"
              ? "none"
              : "height 280ms cubic-bezier(0.2, 0.8, 0.2, 1)",
          overflow: "hidden",
          position: "relative",
          pointerEvents: "none",
        }}
      >
        <RocketIndicator pull={Math.min(1, pull / THRESHOLD)} phase={phase} />
      </div>
      {children}
    </div>
  );
}
