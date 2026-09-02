// Gesture-machine tests for PullToRefresh.
//
// The component is a touch state machine wired straight to native listeners,
// so it is driven here through real touchstart/touchmove/touchend events
// rather than by extracting a reducer — the interesting parts (the engage
// threshold, the resistance curve, the scrollTop guard, the re-entrancy guard
// while a refresh is in flight) live in how those listeners see React state.
//
// Contracts under test:
//   * a pull under the engage threshold does nothing at all,
//   * a pull past the release threshold refreshes exactly once,
//   * dragging back up mid-gesture cancels it,
//   * a scrolled list never starts a pull,
//   * touchcancel resets the same way touchend does.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { PullToRefresh } from "./PullToRefresh";

/** Matches THRESHOLD / MAX_PULL / MIN_REFRESH_MS in the component. */
const THRESHOLD = 72;
const MAX_PULL = 140;
const MIN_REFRESH_MS = 900;

/** dy is halved by the resistance curve, so this clears THRESHOLD. */
const PAST_THRESHOLD_DY = THRESHOLD * 2 + 10;
const UNDER_THRESHOLD_DY = THRESHOLD * 2 - 10;

function touch(clientY: number) {
  return { touches: [{ clientX: 0, clientY }] };
}

/** The scroller is the element the native listeners are attached to. */
function setup(onRefresh: () => Promise<void> | void) {
  render(
    <PullToRefresh onRefresh={onRefresh}>
      <div>message list</div>
    </PullToRefresh>,
  );
  const scroller = screen.getByText("message list").parentElement;
  if (!scroller) throw new Error("scroller not found");
  return scroller;
}

/** The indicator's own label is the readable form of its phase. */
function phaseLabel(): string {
  for (const label of ["Launching", "Release to refresh", "Pull to refresh"]) {
    const found = screen.queryByText(label);
    if (found) return label;
  }
  throw new Error("no indicator label rendered");
}

/** The indicator wrapper's height is the current pull distance. */
function pullHeight(scroller: Element): number {
  const indicator = scroller.firstElementChild as HTMLElement | null;
  if (!indicator) throw new Error("indicator not found");
  return parseFloat(indicator.style.height) || 0;
}

async function drag(scroller: Element, ...ys: number[]) {
  await act(async () => {
    fireEvent.touchStart(scroller, touch(0));
    for (const y of ys) fireEvent.touchMove(scroller, touch(y));
  });
}

async function release(scroller: Element, kind: "end" | "cancel" = "end") {
  await act(async () => {
    if (kind === "end") fireEvent.touchEnd(scroller);
    else fireEvent.touchCancel(scroller);
  });
}

describe("PullToRefresh", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ignores a pull that never clears the engage threshold", async () => {
    const onRefresh = vi.fn(() => Promise.resolve());
    const scroller = setup(onRefresh);

    await drag(scroller, 4, 6); // dy must exceed 6 to engage
    expect(pullHeight(scroller)).toBe(0);

    await release(scroller);
    expect(onRefresh).not.toHaveBeenCalled();
    expect(pullHeight(scroller)).toBe(0);
  });

  it("shows the pull but does not refresh when released under the release threshold", async () => {
    const onRefresh = vi.fn(() => Promise.resolve());
    const scroller = setup(onRefresh);

    await drag(scroller, UNDER_THRESHOLD_DY);
    expect(pullHeight(scroller)).toBe(UNDER_THRESHOLD_DY / 2);
    expect(phaseLabel()).toBe("Pull to refresh");

    await release(scroller);
    expect(onRefresh).not.toHaveBeenCalled();
    expect(pullHeight(scroller)).toBe(0);
    expect(phaseLabel()).toBe("Pull to refresh");
  });

  it("arms at the release threshold and refreshes exactly once on release", async () => {
    const onRefresh = vi.fn(() => Promise.resolve());
    const scroller = setup(onRefresh);

    await drag(scroller, PAST_THRESHOLD_DY);
    expect(phaseLabel()).toBe("Release to refresh");
    expect(onRefresh).not.toHaveBeenCalled(); // not until release

    await release(scroller);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(phaseLabel()).toBe("Launching");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(MIN_REFRESH_MS);
    });
    expect(phaseLabel()).toBe("Pull to refresh");
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("clamps the resistance curve so a long drag cannot exceed the maximum pull", async () => {
    const onRefresh = vi.fn(() => Promise.resolve());
    const scroller = setup(onRefresh);

    await drag(scroller, 5_000);
    expect(pullHeight(scroller)).toBe(MAX_PULL);
    await release(scroller);
  });

  it("cancels the gesture when the finger travels back up past the origin", async () => {
    const onRefresh = vi.fn(() => Promise.resolve());
    const scroller = setup(onRefresh);

    await drag(scroller, PAST_THRESHOLD_DY);
    expect(phaseLabel()).toBe("Release to refresh");

    await drag(scroller, PAST_THRESHOLD_DY, -5); // back above where it started
    expect(pullHeight(scroller)).toBe(0);
    expect(phaseLabel()).toBe("Pull to refresh");

    await release(scroller);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("resets without refreshing when the gesture is cancelled rather than ended", async () => {
    const onRefresh = vi.fn(() => Promise.resolve());
    const scroller = setup(onRefresh);

    await drag(scroller, UNDER_THRESHOLD_DY);
    await release(scroller, "cancel");
    expect(onRefresh).not.toHaveBeenCalled();
    expect(pullHeight(scroller)).toBe(0);
  });

  it("never starts a pull when the list is already scrolled down", async () => {
    const onRefresh = vi.fn(() => Promise.resolve());
    const scroller = setup(onRefresh);
    Object.defineProperty(scroller, "scrollTop", { configurable: true, value: 120 });

    await drag(scroller, PAST_THRESHOLD_DY);
    expect(pullHeight(scroller)).toBe(0);

    await release(scroller);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("ignores a second gesture started while the refresh is still in flight", async () => {
    let settle = () => {};
    const onRefresh = vi.fn(() => new Promise<void>((r) => (settle = r)));
    const scroller = setup(onRefresh);

    await drag(scroller, PAST_THRESHOLD_DY);
    await release(scroller);
    expect(phaseLabel()).toBe("Launching");

    await drag(scroller, PAST_THRESHOLD_DY);
    await release(scroller);
    expect(onRefresh).toHaveBeenCalledTimes(1);

    await act(async () => {
      settle();
      await vi.advanceTimersByTimeAsync(MIN_REFRESH_MS);
    });
    expect(phaseLabel()).toBe("Pull to refresh");
  });

  it("returns to idle even when the refresh rejects", async () => {
    const onRefresh = vi.fn(() => Promise.reject(new Error("network down")));
    const scroller = setup(onRefresh);

    await drag(scroller, PAST_THRESHOLD_DY);
    await release(scroller);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MIN_REFRESH_MS);
    });

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(phaseLabel()).toBe("Pull to refresh");
    expect(pullHeight(scroller)).toBe(0);
  });

  it("holds the launching state for the minimum window even when the refresh is instant", async () => {
    const onRefresh = vi.fn(() => Promise.resolve());
    const scroller = setup(onRefresh);

    await drag(scroller, PAST_THRESHOLD_DY);
    await release(scroller);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(MIN_REFRESH_MS - 50);
    });
    expect(phaseLabel()).toBe("Launching");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(phaseLabel()).toBe("Pull to refresh");
  });
});
