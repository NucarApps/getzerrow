// Skipping is the right behaviour locally — nobody should need a Postgres or
// a deployed URL to run `bun run test`. In CI it is the wrong behaviour: a
// job whose whole purpose is to exercise these suites reports green after
// running nothing, which is how the DB-backed suites sat un-run for months
// while the check looked fine.
//
// `laneDescribe` skips when the lane's env is missing, unless CI is set, in
// which case the suite fails loudly instead.
import { describe, it, expect } from "vitest";

type Describe = typeof describe;

/**
 * `describe` for a suite that needs environment the developer may not have.
 *
 * @param enabled  whether the required env is present
 * @param lane     human name of the lane, for the failure message
 * @param needs    the env vars that would enable it
 */
export function laneDescribe(enabled: boolean, lane: string, needs: string[]): Describe {
  if (enabled) return describe;
  if (!process.env.CI) return describe.skip as Describe;

  const guard = ((name: string, fn?: unknown) => {
    void fn;
    describe(`${lane} (not configured)`, () => {
      it(`refuses to skip in CI: ${name}`, () => {
        expect.fail(
          `${lane} was skipped in CI because ${needs.join(" / ")} ${
            needs.length > 1 ? "are" : "is"
          } unset. A job that runs none of its tests must not report success — ` +
            "set the variable in the workflow or remove the job.",
        );
      });
    });
  }) as unknown as Describe;
  return guard;
}
