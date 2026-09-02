// Gesture-machine tests for SwipeRow — swipe a message row left to archive.
//
// Driven through real touch events rather than an extracted reducer because
// the machine's state lives half in a ref (the axis lock) and half in React
// state (the offset), and the release decision reads both plus the row's
// measured width.
//
// Contracts under test:
//   * a swipe short of a quarter of the row's width does not archive,
//   * a swipe past it archives exactly once,
//   * a vertical scroll locks the axis and cancels the horizontal swipe,
//   * a release mid-gesture always resets the row to its resting position.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SwipeRow } from "./swipe-row";

const ROW_WIDTH = 400;
/** The component archives past 25% of the row's width. */
const PAST_THRESHOLD = ROW_WIDTH * 0.25 + 20;
const UNDER_THRESHOLD = ROW_WIDTH * 0.25 - 20;
/** Both axes must move more than this before the machine commits to one. */
const DEAD_ZONE = 8;

function point(clientX: number, clientY: number) {
  return { touches: [{ clientX, clientY }] };
}

function setup(onArchive: () => void) {
  render(
    <SwipeRow onArchive={onArchive}>
      <div>Quarterly invoice</div>
    </SwipeRow>,
  );
  const panel = screen.getByText("Quarterly invoice").parentElement;
  if (!panel) throw new Error("swipe panel not found");
  return panel as HTMLElement;
}

/** Current horizontal offset of the row, in px (negative is leftward). */
function offset(panel: HTMLElement): number {
  const match = /translateX\((-?[\d.]+)px\)/.exec(panel.style.transform);
  if (!match?.[1]) throw new Error(`unexpected transform: ${panel.style.transform}`);
  return parseFloat(match[1]);
}

describe("SwipeRow", () => {
  beforeEach(() => {
    // jsdom lays nothing out, so offsetWidth is 0 and the component's `|| 1`
    // guard would make every drag clear the 25% threshold.
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(ROW_WIDTH);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts at rest", () => {
    const onArchive = vi.fn();
    expect(offset(setup(onArchive))).toBe(0);
    expect(onArchive).not.toHaveBeenCalled();
  });

  it("follows the finger once the swipe leaves the dead zone", () => {
    const onArchive = vi.fn();
    const panel = setup(onArchive);

    fireEvent.touchStart(panel, point(300, 100));
    fireEvent.touchMove(panel, point(300 - UNDER_THRESHOLD, 100));
    expect(offset(panel)).toBe(-UNDER_THRESHOLD);
    expect(onArchive).not.toHaveBeenCalled();
  });

  it("does not archive a swipe released short of a quarter of the row", () => {
    const onArchive = vi.fn();
    const panel = setup(onArchive);

    fireEvent.touchStart(panel, point(300, 100));
    fireEvent.touchMove(panel, point(300 - UNDER_THRESHOLD, 100));
    fireEvent.touchEnd(panel);

    expect(onArchive).not.toHaveBeenCalled();
    expect(offset(panel)).toBe(0);
  });

  it("archives exactly once when the swipe passes a quarter of the row", () => {
    const onArchive = vi.fn();
    const panel = setup(onArchive);

    fireEvent.touchStart(panel, point(300, 100));
    fireEvent.touchMove(panel, point(300 - PAST_THRESHOLD, 100));
    fireEvent.touchEnd(panel);

    expect(onArchive).toHaveBeenCalledTimes(1);
    expect(offset(panel)).toBe(0);
  });

  it("does not archive again on a stray second release after the gesture ended", () => {
    const onArchive = vi.fn();
    const panel = setup(onArchive);

    fireEvent.touchStart(panel, point(300, 100));
    fireEvent.touchMove(panel, point(300 - PAST_THRESHOLD, 100));
    fireEvent.touchEnd(panel);
    fireEvent.touchEnd(panel);

    expect(onArchive).toHaveBeenCalledTimes(1);
  });

  it("locks to the vertical axis when the finger scrolls, cancelling the swipe", () => {
    const onArchive = vi.fn();
    const panel = setup(onArchive);

    fireEvent.touchStart(panel, point(300, 100));
    // Leaves the dead zone vertically first: |dy| > |dx|, so the row loses the gesture.
    fireEvent.touchMove(panel, point(295, 160));
    expect(offset(panel)).toBe(0);

    // Even a decisive leftward drag afterwards is ignored — the gesture is dead.
    fireEvent.touchMove(panel, point(300 - PAST_THRESHOLD, 160));
    expect(offset(panel)).toBe(0);

    fireEvent.touchEnd(panel);
    expect(onArchive).not.toHaveBeenCalled();
    expect(offset(panel)).toBe(0);
  });

  it("stays undecided inside the dead zone, so a slow swipe is not mistaken for a scroll", () => {
    const onArchive = vi.fn();
    const panel = setup(onArchive);

    fireEvent.touchStart(panel, point(300, 100));
    // dy > dx, but both are inside the dead zone: the axis is NOT locked yet.
    fireEvent.touchMove(panel, point(300 - (DEAD_ZONE - 1), 100 + (DEAD_ZONE - 1)));
    expect(offset(panel)).toBe(0);

    // The gesture is still live, so committing horizontally now works.
    fireEvent.touchMove(panel, point(300 - PAST_THRESHOLD, 100));
    expect(offset(panel)).toBe(-PAST_THRESHOLD);

    fireEvent.touchEnd(panel);
    expect(onArchive).toHaveBeenCalledTimes(1);
  });

  it("stays locked to the horizontal axis once committed, even if the finger drifts down", () => {
    const onArchive = vi.fn();
    const panel = setup(onArchive);

    fireEvent.touchStart(panel, point(300, 100));
    fireEvent.touchMove(panel, point(300 - PAST_THRESHOLD, 100));
    fireEvent.touchMove(panel, point(300 - PAST_THRESHOLD, 400)); // large vertical drift
    expect(offset(panel)).toBe(-PAST_THRESHOLD);

    fireEvent.touchEnd(panel);
    expect(onArchive).toHaveBeenCalledTimes(1);
  });

  it("clamps a rightward swipe to zero — the row only opens one way", () => {
    const onArchive = vi.fn();
    const panel = setup(onArchive);

    fireEvent.touchStart(panel, point(100, 100));
    fireEvent.touchMove(panel, point(100 + PAST_THRESHOLD, 100));
    expect(offset(panel)).toBe(0);

    fireEvent.touchEnd(panel);
    expect(onArchive).not.toHaveBeenCalled();
  });

  it("resets to rest when a swipe short of the threshold is cancelled mid-gesture", () => {
    const onArchive = vi.fn();
    const panel = setup(onArchive);

    fireEvent.touchStart(panel, point(300, 100));
    fireEvent.touchMove(panel, point(300 - UNDER_THRESHOLD, 100));
    expect(offset(panel)).toBe(-UNDER_THRESHOLD);

    fireEvent.touchCancel(panel);
    expect(offset(panel)).toBe(0);
    expect(onArchive).not.toHaveBeenCalled();
  });

  // CHARACTERIZATION(swipe-row-archives-on-touchcancel): an aborted gesture
  // still archives the message — flip when fixed
  it("archives on touchcancel, treating an aborted gesture as a committed one", () => {
    const onArchive = vi.fn();
    const panel = setup(onArchive);

    fireEvent.touchStart(panel, point(300, 100));
    fireEvent.touchMove(panel, point(300 - PAST_THRESHOLD, 100));
    fireEvent.touchCancel(panel);

    expect(onArchive).toHaveBeenCalledTimes(1);
    expect(offset(panel)).toBe(0);
  });

  it("does nothing at all for a tap that never moves", () => {
    const onArchive = vi.fn();
    const panel = setup(onArchive);

    fireEvent.touchStart(panel, point(300, 100));
    fireEvent.touchEnd(panel);

    expect(onArchive).not.toHaveBeenCalled();
    expect(offset(panel)).toBe(0);
  });

  it("ignores a move with no touch point, such as a synthetic scroll event", () => {
    const onArchive = vi.fn();
    const panel = setup(onArchive);

    fireEvent.touchStart(panel, point(300, 100));
    fireEvent.touchMove(panel, { touches: [] });
    expect(offset(panel)).toBe(0);

    fireEvent.touchEnd(panel);
    expect(onArchive).not.toHaveBeenCalled();
  });

  it("archives on any leftward drag when the row reports no width", () => {
    // The `offsetWidth || 1` guard: a row that has not been laid out has a
    // one-pixel threshold, so the lightest committed swipe archives it.
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(0);
    const onArchive = vi.fn();
    const panel = setup(onArchive);

    fireEvent.touchStart(panel, point(300, 100));
    fireEvent.touchMove(panel, point(280, 100)); // 20px, far short of any real threshold
    fireEvent.touchEnd(panel);

    expect(onArchive).toHaveBeenCalledTimes(1);
  });
});
