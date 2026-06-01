import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button } from "@/components/ui/button";
import { Check, RotateCcw } from "lucide-react";

type Rect = { x: number; y: number; w: number; h: number };
type Handle = "tl" | "tr" | "bl" | "br" | "t" | "r" | "b" | "l" | "move";

type Props = {
  /** Source image as data URL. */
  src: string;
  /** Called once user confirms; both data URL and blob are JPEG of the cropped card. */
  onConfirm: (out: { dataUrl: string; blob: Blob; width: number; height: number }) => void;
  onCancel: () => void;
};

/** Downscale dimensions for auto-detect pass. */
const DETECT_MAX = 240;
/** Max output dimension (long edge) of the cropped JPEG. */
const OUTPUT_MAX = 1600;
const OUTPUT_QUALITY = 0.86;

/** Find a tight bounding box around the card by collecting per-row/col edge energy. */
function autoDetectRect(imgW: number, imgH: number, imageData: ImageData): Rect {
  const { data, width: w, height: h } = imageData;
  // Sobel-like horizontal+vertical gradient magnitude per pixel (grayscale).
  const gray = new Float32Array(w * h);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    gray[j] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  const rowE = new Float32Array(h);
  const colE = new Float32Array(w);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = Math.abs(gray[i + 1] - gray[i - 1]);
      const gy = Math.abs(gray[i + w] - gray[i - w]);
      const g = gx + gy;
      rowE[y] += g;
      colE[x] += g;
    }
  }
  const tighten = (energy: Float32Array, len: number): [number, number] => {
    let total = 0;
    for (let i = 0; i < len; i++) total += energy[i];
    if (total <= 0) return [0, len - 1];
    const drop = total * 0.025; // chop 2.5% off each end
    let acc = 0;
    let lo = 0;
    for (let i = 0; i < len; i++) {
      acc += energy[i];
      if (acc >= drop) {
        lo = i;
        break;
      }
    }
    acc = 0;
    let hi = len - 1;
    for (let i = len - 1; i >= 0; i--) {
      acc += energy[i];
      if (acc >= drop) {
        hi = i;
        break;
      }
    }
    return [lo, hi];
  };
  const [y0, y1] = tighten(rowE, h);
  const [x0, x1] = tighten(colE, w);
  // Project back to source image coords and pad slightly.
  const sx = imgW / w;
  const sy = imgH / h;
  const padX = imgW * 0.015;
  const padY = imgH * 0.015;
  const rx = Math.max(0, x0 * sx - padX);
  const ry = Math.max(0, y0 * sy - padY);
  const rw = Math.min(imgW - rx, (x1 - x0 + 1) * sx + padX * 2);
  const rh = Math.min(imgH - ry, (y1 - y0 + 1) * sy + padY * 2);
  // Sanity fallback to a centered 90% rectangle if detection collapsed.
  if (rw < imgW * 0.2 || rh < imgH * 0.2) {
    return { x: imgW * 0.05, y: imgH * 0.05, w: imgW * 0.9, h: imgH * 0.9 };
  }
  return { x: rx, y: ry, w: rw, h: rh };
}

export function CardCropper({ src, onConfirm, onCancel }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const dragRef = useRef<{
    handle: Handle;
    startX: number;
    startY: number;
    startRect: Rect;
  } | null>(null);

  // When the image loads, auto-detect on a downscaled canvas.
  function handleImgLoad() {
    const img = imgRef.current;
    if (!img) return;
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    setImgSize({ w, h });
    const scale = Math.min(1, DETECT_MAX / Math.max(w, h));
    const dw = Math.max(2, Math.round(w * scale));
    const dh = Math.max(2, Math.round(h * scale));
    const c = document.createElement("canvas");
    c.width = dw;
    c.height = dh;
    const ctx = c.getContext("2d");
    if (!ctx) {
      setRect({ x: w * 0.05, y: h * 0.05, w: w * 0.9, h: h * 0.9 });
      return;
    }
    ctx.drawImage(img, 0, 0, dw, dh);
    try {
      const data = ctx.getImageData(0, 0, dw, dh);
      setRect(autoDetectRect(w, h, data));
    } catch {
      setRect({ x: w * 0.05, y: h * 0.05, w: w * 0.9, h: h * 0.9 });
    }
  }

  function reset() {
    if (!imgSize) return;
    setRect({ x: imgSize.w * 0.05, y: imgSize.h * 0.05, w: imgSize.w * 0.9, h: imgSize.h * 0.9 });
  }

  /** Convert a pointer event to image-space coords. */
  function ptToImage(e: ReactPointerEvent | PointerEvent): { x: number; y: number } {
    const img = imgRef.current;
    if (!img || !imgSize) return { x: 0, y: 0 };
    const rectEl = img.getBoundingClientRect();
    const x = ((e.clientX - rectEl.left) / rectEl.width) * imgSize.w;
    const y = ((e.clientY - rectEl.top) / rectEl.height) * imgSize.h;
    return { x, y };
  }

  function onPointerDown(handle: Handle) {
    return (e: ReactPointerEvent) => {
      if (!rect) return;
      e.preventDefault();
      e.stopPropagation();
      (e.target as Element).setPointerCapture?.(e.pointerId);
      const p = ptToImage(e);
      dragRef.current = { handle, startX: p.x, startY: p.y, startRect: { ...rect } };
    };
  }

  useEffect(() => {
    function onMove(e: PointerEvent) {
      const d = dragRef.current;
      if (!d || !imgSize) return;
      const p = ptToImage(e);
      const dx = p.x - d.startX;
      const dy = p.y - d.startY;
      const r = { ...d.startRect };
      const minSize = 30;
      const apply = (nx: number, ny: number, nw: number, nh: number) => {
        const x = Math.max(0, Math.min(nx, imgSize.w - minSize));
        const y = Math.max(0, Math.min(ny, imgSize.h - minSize));
        const w = Math.max(minSize, Math.min(nw, imgSize.w - x));
        const h = Math.max(minSize, Math.min(nh, imgSize.h - y));
        setRect({ x, y, w, h });
      };
      switch (d.handle) {
        case "move":
          apply(r.x + dx, r.y + dy, r.w, r.h);
          break;
        case "tl":
          apply(r.x + dx, r.y + dy, r.w - dx, r.h - dy);
          break;
        case "tr":
          apply(r.x, r.y + dy, r.w + dx, r.h - dy);
          break;
        case "bl":
          apply(r.x + dx, r.y, r.w - dx, r.h + dy);
          break;
        case "br":
          apply(r.x, r.y, r.w + dx, r.h + dy);
          break;
        case "t":
          apply(r.x, r.y + dy, r.w, r.h - dy);
          break;
        case "b":
          apply(r.x, r.y, r.w, r.h + dy);
          break;
        case "l":
          apply(r.x + dx, r.y, r.w - dx, r.h);
          break;
        case "r":
          apply(r.x, r.y, r.w + dx, r.h);
          break;
      }
    }
    function onUp() {
      dragRef.current = null;
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    // Re-subscribe only when imgSize changes. ptToImage reads imgSize (a dep)
    // and refs, so its closure stays correct; listing the per-render function
    // would needlessly re-add the listeners on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imgSize]);

  async function confirm() {
    const img = imgRef.current;
    if (!img || !rect || !imgSize) return;
    const scale = Math.min(1, OUTPUT_MAX / Math.max(rect.w, rect.h));
    const outW = Math.max(1, Math.round(rect.w * scale));
    const outH = Math.max(1, Math.round(rect.h * scale));
    const c = document.createElement("canvas");
    c.width = outW;
    c.height = outH;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h, 0, 0, outW, outH);
    const blob: Blob | null = await new Promise((resolve) =>
      c.toBlob(resolve, "image/jpeg", OUTPUT_QUALITY),
    );
    if (!blob) return;
    const dataUrl = c.toDataURL("image/jpeg", OUTPUT_QUALITY);
    onConfirm({ dataUrl, blob, width: outW, height: outH });
  }

  // Compute overlay rect in CSS pixels using the displayed image size.
  const overlay = (() => {
    if (!rect || !imgSize || !imgRef.current) return null;
    const el = imgRef.current;
    const cw = el.clientWidth;
    const ch = el.clientHeight;
    const sx = cw / imgSize.w;
    const sy = ch / imgSize.h;
    return { left: rect.x * sx, top: rect.y * sy, width: rect.w * sx, height: rect.h * sy };
  })();

  return (
    <div className="space-y-3">
      <div
        ref={containerRef}
        className="relative inline-block w-full bg-muted/30 rounded-md overflow-hidden border border-border"
      >
        <img
          ref={imgRef}
          src={src}
          alt="Card to crop"
          onLoad={handleImgLoad}
          className="block w-full h-auto select-none touch-none"
          draggable={false}
        />
        {overlay && (
          <>
            {/* Dimmed mask outside crop */}
            <div className="pointer-events-none absolute inset-0">
              <div
                className="absolute inset-0 bg-background/60"
                style={{
                  clipPath: `polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 ${overlay.top}px, ${overlay.left}px ${overlay.top}px, ${overlay.left}px ${overlay.top + overlay.height}px, ${overlay.left + overlay.width}px ${overlay.top + overlay.height}px, ${overlay.left + overlay.width}px ${overlay.top}px, 0 ${overlay.top}px)`,
                }}
              />
            </div>
            {/* Crop frame */}
            <div
              className="absolute border-2 border-primary cursor-move touch-none"
              style={{
                left: overlay.left,
                top: overlay.top,
                width: overlay.width,
                height: overlay.height,
              }}
              onPointerDown={onPointerDown("move")}
            >
              {/* Edge handles */}
              <div
                className="absolute left-0 right-0 -top-1 h-2 cursor-ns-resize touch-none"
                onPointerDown={onPointerDown("t")}
              />
              <div
                className="absolute left-0 right-0 -bottom-1 h-2 cursor-ns-resize touch-none"
                onPointerDown={onPointerDown("b")}
              />
              <div
                className="absolute top-0 bottom-0 -left-1 w-2 cursor-ew-resize touch-none"
                onPointerDown={onPointerDown("l")}
              />
              <div
                className="absolute top-0 bottom-0 -right-1 w-2 cursor-ew-resize touch-none"
                onPointerDown={onPointerDown("r")}
              />
              {/* Corner handles */}
              {(["tl", "tr", "bl", "br"] as const).map((h) => (
                <div
                  key={h}
                  onPointerDown={onPointerDown(h)}
                  className={`absolute h-4 w-4 rounded-sm bg-primary border-2 border-background touch-none ${
                    h === "tl"
                      ? "-left-2 -top-2 cursor-nwse-resize"
                      : h === "tr"
                        ? "-right-2 -top-2 cursor-nesw-resize"
                        : h === "bl"
                          ? "-left-2 -bottom-2 cursor-nesw-resize"
                          : "-right-2 -bottom-2 cursor-nwse-resize"
                  }`}
                />
              ))}
            </div>
          </>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Drag the corners or edges to fit the card exactly.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button onClick={confirm} disabled={!rect}>
          <Check className="mr-2 h-4 w-4" /> Use this crop
        </Button>
        <Button variant="outline" onClick={reset} disabled={!rect}>
          <RotateCcw className="mr-2 h-4 w-4" /> Reset
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
