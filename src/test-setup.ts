// Global test teardown. Guarantees no mock, stubbed global (e.g. fetch),
// stubbed env var, or fake clock can leak from one test into the next —
// even when an assertion throws before a test's own cleanup line runs.
// Teardown only: no fakes are installed here.
import { afterEach, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
