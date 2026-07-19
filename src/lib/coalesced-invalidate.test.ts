import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createCoalescedInvalidator } from "./coalesced-invalidate";

describe("createCoalescedInvalidator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("collapses N requests inside the window into one flush", () => {
    const flush = vi.fn();
    const inv = createCoalescedInvalidator(flush, { windowMs: 1000, minIntervalMs: 5000 });
    inv.request(["emails"]);
    inv.request(["emails"]);
    inv.request(["emails"]);
    expect(flush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith([["emails"]]);
    inv.dispose();
  });

  it("batches distinct query keys into the same flush, deduplicated", () => {
    const flush = vi.fn();
    const inv = createCoalescedInvalidator(flush, { windowMs: 1000, minIntervalMs: 5000 });
    inv.request(["emails"]);
    inv.request(["folder-counts"]);
    inv.request(["emails"]);
    vi.advanceTimersByTime(1000);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith([["emails"], ["folder-counts"]]);
    inv.dispose();
  });

  it("enforces the minimum interval between flushes", () => {
    const flush = vi.fn();
    const inv = createCoalescedInvalidator(flush, { windowMs: 1000, minIntervalMs: 5000 });
    inv.request(["emails"]);
    vi.advanceTimersByTime(1000);
    expect(flush).toHaveBeenCalledTimes(1);

    // A request right after a flush waits out the remaining min-interval,
    // not just the window.
    inv.request(["emails"]);
    vi.advanceTimersByTime(1000);
    expect(flush).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(4000); // now 5s past the first flush
    expect(flush).toHaveBeenCalledTimes(2);
    inv.dispose();
  });

  it("requests after a quiet period flush on the plain window again", () => {
    const flush = vi.fn();
    const inv = createCoalescedInvalidator(flush, { windowMs: 1000, minIntervalMs: 5000 });
    inv.request(["emails"]);
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(60_000); // long quiet gap
    inv.request(["emails"]);
    vi.advanceTimersByTime(1000);
    expect(flush).toHaveBeenCalledTimes(2);
    inv.dispose();
  });

  it("dispose cancels any pending flush", () => {
    const flush = vi.fn();
    const inv = createCoalescedInvalidator(flush, { windowMs: 1000, minIntervalMs: 5000 });
    inv.request(["emails"]);
    inv.dispose();
    vi.advanceTimersByTime(10_000);
    expect(flush).not.toHaveBeenCalled();
  });
});
