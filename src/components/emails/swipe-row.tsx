import { useState, useRef } from "react";
import { Archive } from "lucide-react";

export function SwipeRow({
  onArchive,
  children,
}: {
  onArchive: () => void;
  children: React.ReactNode;
}) {
  const [dx, setDx] = useState(0);
  const startRef = useRef<{ x: number; y: number; active: boolean; locked: boolean } | null>(null);

  function onTouchStart(e: React.TouchEvent) {
    const t = e.touches[0];
    startRef.current = { x: t.clientX, y: t.clientY, active: true, locked: false };
  }
  function onTouchMove(e: React.TouchEvent) {
    const s = startRef.current;
    if (!s || !s.active) return;
    const t = e.touches[0];
    const dxRaw = t.clientX - s.x;
    const dyRaw = t.clientY - s.y;
    if (!s.locked) {
      if (Math.abs(dxRaw) < 8 && Math.abs(dyRaw) < 8) return;
      if (Math.abs(dyRaw) > Math.abs(dxRaw)) {
        s.active = false;
        return;
      }
      s.locked = true;
    }
    setDx(Math.min(0, dxRaw));
  }
  function onTouchEnd(e: React.TouchEvent) {
    const s = startRef.current;
    startRef.current = null;
    if (!s || !s.locked) {
      setDx(0);
      return;
    }
    const width = (e.currentTarget as HTMLElement).offsetWidth || 1;
    if (-dx > width * 0.25) {
      setDx(0);
      onArchive();
    } else {
      setDx(0);
    }
  }

  return (
    <div className="relative overflow-hidden border-b border-border">
      <div className="pointer-events-none absolute inset-0 flex items-center justify-end bg-destructive pr-6 text-destructive-foreground">
        <Archive className="h-5 w-5" />
      </div>
      <div
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
        style={{
          transform: `translateX(${dx}px)`,
          transition: dx === 0 ? "transform 120ms ease-out" : "none",
        }}
        className="relative bg-background"
      >
        {children}
      </div>
    </div>
  );
}
