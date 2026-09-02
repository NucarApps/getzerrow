// Tests for the screen wake lock used while a meeting is recording.
//
// Contracts under test:
//   * the native Screen Wake Lock API is preferred, and nothing is added to
//     the DOM when it works,
//   * a browser without the API — or one that rejects the request — gets the
//     hidden looping muted video instead (the NoSleep.js fallback),
//   * release() and unmount both hand the lock back and take the video away,
//   * returning to a hidden tab re-acquires, because browsers drop the native
//     lock on hide, but only while the caller still wants it.
//
// navigator.wakeLock is stubbed by putting the real navigator behind an
// object that carries the extra property, so everything else jsdom's
// navigator provides keeps working.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useScreenWakeLock } from "./use-screen-wake-lock";

type Sentinel = { release: () => Promise<void> };

function makeSentinel(): Sentinel & { release: ReturnType<typeof vi.fn> } {
  return { release: vi.fn(async () => {}) };
}

/** Give `navigator` a wakeLock whose request behaves as `impl` says. */
function stubWakeLock(request: (type: string) => Promise<Sentinel>) {
  const spy = vi.fn(request);
  vi.stubGlobal(
    "navigator",
    Object.create(globalThis.navigator, {
      wakeLock: { value: { request: spy }, configurable: true, enumerable: true },
    }),
  );
  return spy;
}

/** A browser with no Screen Wake Lock API at all. */
function stubNoWakeLock() {
  vi.stubGlobal("navigator", Object.create(globalThis.navigator));
}

function stubVisibility(state: DocumentVisibilityState) {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue(state);
}

function keepAwakeVideo(): HTMLVideoElement | null {
  return document.body.querySelector<HTMLVideoElement>('video[title="Keeping screen awake"]');
}

let play: ReturnType<typeof vi.fn<() => Promise<void>>>;
let pause: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  // jsdom implements neither; without these the fallback path throws.
  play = vi.fn<() => Promise<void>>(async () => {});
  pause = vi.fn<() => void>(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(play);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(pause);
});

describe("useScreenWakeLock — the native lock", () => {
  it("requests a screen lock and leaves the DOM alone", async () => {
    const sentinel = makeSentinel();
    const request = stubWakeLock(async () => sentinel);
    const { result } = renderHook(() => useScreenWakeLock());

    await act(async () => {
      await result.current.acquire();
    });

    expect(request).toHaveBeenCalledWith("screen");
    expect(play).not.toHaveBeenCalled();
    expect(keepAwakeVideo()).toBeNull();
  });

  it("hands the lock back on release", async () => {
    const sentinel = makeSentinel();
    stubWakeLock(async () => sentinel);
    const { result } = renderHook(() => useScreenWakeLock());

    await act(async () => {
      await result.current.acquire();
    });
    act(() => {
      result.current.release();
    });

    expect(sentinel.release).toHaveBeenCalledTimes(1);
  });

  it("does not release the same sentinel twice", async () => {
    const sentinel = makeSentinel();
    stubWakeLock(async () => sentinel);
    const { result } = renderHook(() => useScreenWakeLock());

    await act(async () => {
      await result.current.acquire();
    });
    act(() => {
      result.current.release();
      result.current.release();
    });

    expect(sentinel.release).toHaveBeenCalledTimes(1);
  });

  it("survives a sentinel whose release rejects", async () => {
    const sentinel = { release: vi.fn(async () => Promise.reject(new Error("already released"))) };
    stubWakeLock(async () => sentinel);
    const { result } = renderHook(() => useScreenWakeLock());

    await act(async () => {
      await result.current.acquire();
    });

    expect(() => act(() => result.current.release())).not.toThrow();
  });

  it("hands the lock back when the component unmounts mid-recording", async () => {
    const sentinel = makeSentinel();
    stubWakeLock(async () => sentinel);
    const { result, unmount } = renderHook(() => useScreenWakeLock());

    await act(async () => {
      await result.current.acquire();
    });
    unmount();

    expect(sentinel.release).toHaveBeenCalledTimes(1);
  });
});

describe("useScreenWakeLock — the hidden-video fallback", () => {
  it("plays a hidden looping muted video when the browser has no wake lock API", async () => {
    stubNoWakeLock();
    const { result } = renderHook(() => useScreenWakeLock());

    await act(async () => {
      await result.current.acquire();
    });

    const video = keepAwakeVideo();
    expect(video).not.toBeNull();
    expect(video!.muted).toBe(true);
    expect(video!.loop).toBe(true);
    expect(video!.playsInline).toBe(true);
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("offers both a webm and an mp4 source so every fallback browser has one", async () => {
    stubNoWakeLock();
    const { result } = renderHook(() => useScreenWakeLock());

    await act(async () => {
      await result.current.acquire();
    });

    const sources = [...keepAwakeVideo()!.querySelectorAll("source")];
    expect(sources.map((s) => s.type)).toStrictEqual(["video/webm", "video/mp4"]);
    expect(sources.every((s) => s.src.startsWith("data:"))).toBe(true);
  });

  it("keeps the video out of the way rather than visible on the page", async () => {
    stubNoWakeLock();
    const { result } = renderHook(() => useScreenWakeLock());

    await act(async () => {
      await result.current.acquire();
    });

    const style = keepAwakeVideo()!.style;
    expect(style.position).toBe("fixed");
    expect(style.opacity).toBe("0");
    expect(style.pointerEvents).toBe("none");
  });

  it("falls back to the video when the native request is rejected", async () => {
    const request = stubWakeLock(async () => Promise.reject(new Error("not allowed")));
    const { result } = renderHook(() => useScreenWakeLock());

    await act(async () => {
      await result.current.acquire();
    });

    expect(request).toHaveBeenCalledWith("screen");
    expect(keepAwakeVideo()).not.toBeNull();
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("carries on when even the video is blocked from playing", async () => {
    stubNoWakeLock();
    play.mockRejectedValue(new Error("gesture required"));
    const { result } = renderHook(() => useScreenWakeLock());

    await expect(
      act(async () => {
        await result.current.acquire();
      }),
    ).resolves.toBeUndefined();
    expect(keepAwakeVideo()).not.toBeNull();
  });

  it("reuses the one video across repeated acquires", async () => {
    stubNoWakeLock();
    const { result } = renderHook(() => useScreenWakeLock());

    await act(async () => {
      await result.current.acquire();
      await result.current.acquire();
    });

    expect(document.body.querySelectorAll("video")).toHaveLength(1);
    expect(play).toHaveBeenCalledTimes(2);
  });

  it("pauses and removes the video on release", async () => {
    stubNoWakeLock();
    const { result } = renderHook(() => useScreenWakeLock());

    await act(async () => {
      await result.current.acquire();
    });
    act(() => {
      result.current.release();
    });

    expect(pause).toHaveBeenCalledTimes(1);
    expect(keepAwakeVideo()).toBeNull();
  });

  it("removes the video when the component unmounts mid-recording", async () => {
    stubNoWakeLock();
    const { result, unmount } = renderHook(() => useScreenWakeLock());

    await act(async () => {
      await result.current.acquire();
    });
    unmount();

    expect(keepAwakeVideo()).toBeNull();
  });

  it("does nothing on a release that was never preceded by an acquire", () => {
    stubNoWakeLock();
    const { result } = renderHook(() => useScreenWakeLock());

    act(() => {
      result.current.release();
    });

    expect(pause).not.toHaveBeenCalled();
    expect(keepAwakeVideo()).toBeNull();
  });
});

describe("useScreenWakeLock — returning to the tab", () => {
  async function acquireThen(request: (type: string) => Promise<Sentinel>) {
    const spy = stubWakeLock(request);
    const rendered = renderHook(() => useScreenWakeLock());
    await act(async () => {
      await rendered.result.current.acquire();
    });
    return { ...rendered, request: spy };
  }

  it("re-acquires the lock the browser dropped while the tab was hidden", async () => {
    const { request } = await acquireThen(async () => makeSentinel());
    stubVisibility("visible");

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not re-acquire while the tab is still hidden", async () => {
    const { request } = await acquireThen(async () => makeSentinel());
    stubVisibility("hidden");

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not re-acquire after the caller has released the lock", async () => {
    const { result, request } = await acquireThen(async () => makeSentinel());
    act(() => {
      result.current.release();
    });
    stubVisibility("visible");

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(request).toHaveBeenCalledTimes(1);
  });

  it("stops listening once the component unmounts", async () => {
    const { unmount, request } = await acquireThen(async () => makeSentinel());
    unmount();
    stubVisibility("visible");

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(request).toHaveBeenCalledTimes(1);
  });
});
