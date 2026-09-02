// The per-account coalescing lock, tested directly.
//
// history-concurrency.test.ts drives it through syncSinceHistory, which
// proves the integration but cannot reach the state machine's edges: the
// rejection paths, the "exactly ONE follow-up" rule, and what the map
// holds afterwards. Those edges are where a lock leaks — a rejected
// in-flight run that poisons every later caller for that account is a
// mailbox that silently stops syncing until the process restarts.
import { describe, it, expect } from "vitest";
import { withAccountLock } from "./account-lock";

const ACC = "acc-1";

/** A promise plus its resolve/reject, so a test controls when work ends. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let queued microtasks (the follow-up chain) run. */
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("withAccountLock", () => {
  it("runs the first caller immediately", async () => {
    const order: string[] = [];
    await withAccountLock(ACC, async () => {
      order.push("ran");
    });
    expect(order).toEqual(["ran"]);
  });

  it("chains exactly ONE follow-up run, however many callers overlap", async () => {
    // The in-flight run may have issued its listHistory BEFORE the event
    // that woke the overlapping callers, so they cannot simply return its
    // promise — but they must not each queue their own run either.
    const gate = deferred<void>();
    const starts: number[] = [];
    let n = 0;
    const work = async () => {
      const id = ++n;
      starts.push(id);
      if (id === 1) await gate.promise;
      return id;
    };

    const first = withAccountLock(ACC, work);
    await tick();
    expect(starts).toEqual([1]);

    const second = withAccountLock(ACC, work);
    const third = withAccountLock(ACC, work);
    const fourth = withAccountLock(ACC, work);
    // Nothing new started while the first run is still in flight.
    await tick();
    expect(starts).toEqual([1]);

    gate.resolve();
    const [a, b, c, d] = await Promise.all([first, second, third, fourth]);
    expect(a).toBe(1);
    // Three overlapping callers, ONE follow-up run, shared by all of them.
    expect(starts).toEqual([1, 2]);
    expect([b, c, d]).toEqual([2, 2, 2]);
  });

  it("does not coalesce across accounts", async () => {
    const gate = deferred<void>();
    const started: string[] = [];
    const run = (id: string) =>
      withAccountLock(id, async () => {
        started.push(id);
        await gate.promise;
        return id;
      });

    const a = run("acc-a");
    const b = run("acc-b");
    await tick();
    expect(started.sort()).toEqual(["acc-a", "acc-b"]);
    gate.resolve();
    expect(await Promise.all([a, b])).toEqual(["acc-a", "acc-b"]);
  });

  it("releases the lock after a run, so a later call executes fresh rather than coalescing", async () => {
    let runs = 0;
    await withAccountLock(ACC, async () => void runs++);
    await withAccountLock(ACC, async () => void runs++);
    expect(runs).toBe(2);
  });

  it("a rejected run rejects its own caller and releases the lock", async () => {
    await expect(
      withAccountLock(ACC, async () => {
        throw new Error("gmail 429");
      }),
    ).rejects.toThrow("gmail 429");

    // The next caller runs; it is not stuck behind a dead lock entry.
    await expect(withAccountLock(ACC, async () => "ok")).resolves.toBe("ok");
  });

  // The failure this exists to prevent: a rejected in-flight run whose
  // rejection propagates into the follow-up chain would reject every
  // subsequent caller for that account, and the account would stop syncing
  // until the process restarted.
  it("an in-flight rejection does not poison the follow-up", async () => {
    const gate = deferred<void>();
    const inFlight = withAccountLock(ACC, async () => {
      await gate.promise;
      throw new Error("in-flight failed");
    });
    // Claim the rejection so it is not unhandled.
    const inFlightResult = inFlight.catch((e: Error) => e.message);

    await tick();
    const followUp = withAccountLock(ACC, async () => "follow-up ran");

    gate.resolve();
    expect(await inFlightResult).toBe("in-flight failed");
    expect(await followUp).toBe("follow-up ran");
  });

  it("a follow-up that itself rejects leaves the account usable", async () => {
    const gate = deferred<void>();
    const inFlight = withAccountLock(ACC, async () => {
      await gate.promise;
      return "first";
    });
    await tick();
    const followUp = withAccountLock(ACC, async () => {
      throw new Error("follow-up failed");
    });
    const followUpResult = followUp.catch((e: Error) => e.message);

    gate.resolve();
    expect(await inFlight).toBe("first");
    expect(await followUpResult).toBe("follow-up failed");

    await expect(withAccountLock(ACC, async () => "later")).resolves.toBe("later");
  });

  it("a caller arriving during the FOLLOW-UP chains one more run, not two", async () => {
    const gate1 = deferred<void>();
    const gate2 = deferred<void>();
    const starts: number[] = [];
    let n = 0;
    const work = async () => {
      const id = ++n;
      starts.push(id);
      if (id === 1) await gate1.promise;
      if (id === 2) await gate2.promise;
      return id;
    };

    const first = withAccountLock(ACC, work);
    await tick();
    const second = withAccountLock(ACC, work);
    gate1.resolve();
    await first;
    await tick();
    expect(starts).toEqual([1, 2]);

    // Two more callers while run 2 is in flight → exactly one further run.
    const third = withAccountLock(ACC, work);
    const fourth = withAccountLock(ACC, work);
    await tick();
    gate2.resolve();
    await Promise.all([second, third, fourth]);
    expect(starts).toEqual([1, 2, 3]);
  });
});
