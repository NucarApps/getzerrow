import { describe, expect, it } from "vitest";
import { describeGoldenFailures, runGolden, type GoldenCase } from "./golden";
import { GOLDEN_CASES, GOLDEN_FOLDERS, goldenContext } from "./golden-dataset";

describe("golden set", () => {
  it("scores 100% — every labelled case files where and how it should", () => {
    const report = runGolden(GOLDEN_CASES, goldenContext());
    expect(describeGoldenFailures(report)).toBe("all golden cases pass");
    expect(report.accuracy).toBe(1);
  });

  it("reports the folder and the stage of a regression", () => {
    const broken: GoldenCase[] = [
      {
        id: "wrong-folder",
        intent: "deliberately mislabelled, to prove the harness fails loudly",
        message: {
          from_addr: "billing@netflix.com",
          from_name: "Netflix",
          to_addrs: "me@example.com",
          subject: "Your receipt",
          body_text: "",
          has_attachment: false,
        },
        expect_folder_id: GOLDEN_FOLDERS.newsletters,
        expect_stage: "rule",
      },
    ];
    const report = runGolden(broken, goldenContext());
    expect(report.accuracy).toBe(0);
    expect(report.failures[0]!.actual.folder_id).toBe(GOLDEN_FOLDERS.receipts);
    expect(describeGoldenFailures(report)).toContain("expected");
  });

  it("treats an empty set as passing rather than dividing by zero", () => {
    expect(runGolden([], goldenContext()).accuracy).toBe(1);
  });
});
