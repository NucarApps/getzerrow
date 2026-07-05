import { useCallback, useEffect, useRef } from "react";

// Tiny (0.5s, 64x64, black) looping clips inlined as data URIs. Playing a muted,
// inline video is the well-established NoSleep.js fallback that keeps the screen
// awake on browsers without the Screen Wake Lock API (notably older iOS Safari).
const FALLBACK_MP4 =
  "data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAANdbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAAlgAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAoh0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAAlgAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAEAAAABAAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAJYAAAQAAABAAAAAAIAbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAoAAAAIABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABq21pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAWtzdGJsAAAAv3N0c2QAAAAAAAAAAQAAAK9hdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAEAAQABIAAAASAAAAAAAAAABFUxhdmM2Mi4xMS4xMDAgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAANWF2Y0MBZAAK/+EAGGdkAAqs2UQmwEQAAAMABAAAAwAoPEiWWAEABmjr48siwP34+AAAAAAQcGFzcAAAAAEAAAABAAAAFGJ0cnQAAAAAAAAmcAAAAAAAAAAYc3R0cwAAAAAAAAABAAAAAwAACAAAAAAUc3RzcwAAAAAAAAABAAAAAQAAAChjdHRzAAAAAAAAAAMAAAABAAAQAAAAAAEAABgAAAAAAQAACAAAAAAcc3RzYwAAAAAAAAABAAAAAQAAAAMAAAABAAAAIHN0c3oAAAAAAAAAAAAAAAMAAALIAAAADgAAAAwAAAAUc3RjbwAAAAAAAAABAAADjQAAAGF1ZHRhAAAAWW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALGlsc3QAAAAkqXRvbwAAABxkYXRhAAAAAQAAAABMYXZmNjIuMy4xMDAAAAAIZnJlZQAAAuptZGF0AAACnwYF//+b3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NCAtIEguMjY0L01QRUctNCBBVkMgY29kZWMgLSBDb3B5bGVmdCAyMDAzLTIwMjUgLSBodHRwOi8vd3d3LnZpZGVvbGFuLm9yZy94MjY0Lmh0bWwgLSBvcHRpb25zOiBjYWJhYz0xIHJlZj0zIGRlYmxvY2s9MTowOjAgYW5hbHlzZT0weDM6MHgxMTMgbWU9aGV4IHN1Ym1lPTcgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MSBtZV9yYW5nZT0xNiBjaHJvbWFfbWU9MSB0cmVsbGlzPTEgOHg4ZGN0PTEgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz0yIGxvb2thaGVhZF90aHJlYWRzPTEgc2xpY2VkX3RocmVhZHM9MCBucj0wIGRlY2ltYXRlPTEgaW50ZXJsYWNlZD0wIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MyBiX3B5cmFtaWQ9MiBiX2FkYXB0PTEgYl9iaWFzPTAgZGlyZWN0PTEgd2VpZ2h0Yj0xIG9wZW5fZ29wPTAgd2VpZ2h0cD0yIGtleWludD0yNTAga2V5aW50X21pbj01IHNjZW5lY3V0PTQwIGludHJhX3JlZnJlc2g9MCByY19sb29rYWhlYWQ9NDAgcmM9Y3JmIG1idHJlZT0xIGNyZj0yMy4wIHFjb21wPTAuNjAgcXBtaW49MCBxcG1heD02OSBxcHN0ZXA9NCBpcF9yYXRpbz0xLjQwIGFxPTE6MS4wMACAAAAAIWWIhAAR//73iB8yy2+catdyEeesVP1GIxltc+dmuhineQAAAApBmiJsQ//+qZ00AAAACAGeQXkP/wTF";

const FALLBACK_WEBM =
  "data:video/webm;base64,GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAIdEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHWTbuMU6uEElTDZ1OsggEjTbuMU6uEHFO7a1OsggIH7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrXsYMPQkBNgIxMYXZmNjIuMy4xMDBXQYxMYXZmNjIuMy4xMDBEiYhAgsAAAAAAABZUrmvIrgEAAAAAAAA/14EBc8WI8SM1ohct3wucgQAitZyDdW5kiIEAhoVWX1ZQOIOBASPjg4QL68IA4JCwgUC6gUCagQJVsIRVuYEBElTDZ/tzc59jwIBnyJlFo4dFTkNPREVSRIeMTGF2ZjYyLjMuMTAwc3PWY8CLY8WI8SM1ohct3wtnyKFFo4dFTkNPREVSRIeUTGF2YzYyLjExLjEwMCBsaWJ2cHhnyKFFo4hEVVJBVElPTkSHkzAwOjAwOjAwLjYwMDAwMDAwMAAfQ7Z13+eBAKOqgQAAgPACAJ0BKkAAQAAARwiFhYiFhIgCAgAGcDxCYAqyIPcwAP7/q1CAo5aBAMgA0QEABRCsABgAGFgv9AAIjoAAo5aBAZAA0QEABRCsABgAGFgv9AAIjoAAHFO7a5G7j7OBALeK94EB8YIBo/CBAw==";

/**
 * Keeps the screen awake while an operation (e.g. a recording) is in progress.
 *
 * Prefers the native Screen Wake Lock API and transparently falls back to a
 * hidden looping muted video for browsers that lack it, so mobile recordings
 * aren't interrupted when the device would otherwise sleep and suspend the tab.
 *
 * Must be triggered from a user gesture (the fallback video's `play()` requires
 * one) — calling `acquire()` from a click handler satisfies this.
 */
export function useScreenWakeLock() {
  const sentinelRef = useRef<WakeLockSentinel | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const activeRef = useRef(false);
  const visibilityHandlerRef = useRef<(() => void) | null>(null);

  const startFallbackVideo = useCallback(async () => {
    if (typeof document === "undefined") return;
    let video = videoRef.current;
    if (!video) {
      video = document.createElement("video");
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.setAttribute("muted", "");
      video.setAttribute("playsinline", "");
      video.setAttribute("webkit-playsinline", "");
      video.setAttribute("title", "Keeping screen awake");
      video.style.position = "fixed";
      video.style.width = "1px";
      video.style.height = "1px";
      video.style.opacity = "0";
      video.style.pointerEvents = "none";
      video.style.left = "-1px";
      video.style.top = "-1px";

      const mp4 = document.createElement("source");
      mp4.src = FALLBACK_MP4;
      mp4.type = "video/mp4";
      const webm = document.createElement("source");
      webm.src = FALLBACK_WEBM;
      webm.type = "video/webm";
      video.appendChild(webm);
      video.appendChild(mp4);

      document.body.appendChild(video);
      videoRef.current = video;
    }
    try {
      await video.play();
    } catch {
      // Even the fallback was blocked — recording still proceeds, the screen
      // just may not be held. No further action possible without a gesture.
    }
  }, []);

  const stopFallbackVideo = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    try {
      video.pause();
    } catch {
      // ignore
    }
    video.remove();
    videoRef.current = null;
  }, []);

  const acquire = useCallback(async () => {
    activeRef.current = true;
    if ("wakeLock" in navigator) {
      try {
        sentinelRef.current = await navigator.wakeLock.request("screen");
        return;
      } catch {
        // Unsupported in this context or rejected — fall through to the video.
      }
    }
    await startFallbackVideo();
  }, [startFallbackVideo]);

  const release = useCallback(() => {
    activeRef.current = false;
    void sentinelRef.current?.release().catch(() => {});
    sentinelRef.current = null;
    stopFallbackVideo();
  }, [stopFallbackVideo]);

  // Browsers auto-release the native lock when the tab is hidden; re-acquire it
  // when the user returns so a mid-recording app switch doesn't drop it.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && activeRef.current) {
        void acquire();
      }
    };
    visibilityHandlerRef.current = onVisible;
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      visibilityHandlerRef.current = null;
      void sentinelRef.current?.release().catch(() => {});
      sentinelRef.current = null;
      stopFallbackVideo();
    };
  }, [acquire, stopFallbackVideo]);

  return { acquire, release };
}
