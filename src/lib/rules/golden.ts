// The golden set harness (Amendment 5, Phase E).
//
// Accuracy is measured, not asserted in prose: a fixed set of labelled
// messages, the engine run over them with the AI stage OFF, and a score.
// A change that moves a golden case is a change that has to be argued for
// in a diff, not discovered in production.
//
// PURE: no Supabase, no AI, no clock. Cases live in ./golden-dataset.ts.
import { evaluate } from "./evaluate";
import type { EngineMessage, EvaluateContext, Stage } from "./types";

export type GoldenCase = {
  id: string;
  /** What this case pins down, in one line. */
  intent: string;
  message: EngineMessage;
  /** null = must stay in the Inbox. */
  expect_folder_id: string | null;
  /** The stage that must produce the decision. A case that reaches the
   * right folder through the wrong stage is still a failure: it means the
   * precedence changed. */
  expect_stage: Stage;
};

export type GoldenFailure = {
  id: string;
  intent: string;
  expected: { folder_id: string | null; stage: Stage };
  actual: { folder_id: string | null; stage: Stage; reason: string };
};

export type GoldenReport = {
  total: number;
  passed: number;
  /** Passed / total, rounded to three decimals. */
  accuracy: number;
  failures: GoldenFailure[];
};

export function runGolden(cases: GoldenCase[], context: EvaluateContext): GoldenReport {
  const failures: GoldenFailure[] = [];

  for (const c of cases) {
    const result = evaluate(c.message, context, { trigger: "arrival", aiEnabled: false });
    if (result.folder_id === c.expect_folder_id && result.stage === c.expect_stage) continue;
    failures.push({
      id: c.id,
      intent: c.intent,
      expected: { folder_id: c.expect_folder_id, stage: c.expect_stage },
      actual: { folder_id: result.folder_id, stage: result.stage, reason: result.reason },
    });
  }

  const passed = cases.length - failures.length;
  return {
    total: cases.length,
    passed,
    accuracy: cases.length === 0 ? 1 : Math.round((passed / cases.length) * 1000) / 1000,
    failures,
  };
}

/** Readable failure list for a test message or a CI log. */
export function describeGoldenFailures(report: GoldenReport): string {
  if (report.failures.length === 0) return "all golden cases pass";
  return report.failures
    .map(
      (f) =>
        `${f.id} (${f.intent}): expected ${f.expected.folder_id ?? "Inbox"} via ${f.expected.stage}, got ${f.actual.folder_id ?? "Inbox"} via ${f.actual.stage} — ${f.actual.reason}`,
    )
    .join("\n");
}
