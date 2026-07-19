// Enqueue selection for background bio enrichment: who gets a job this
// tick. Pure — the server wrapper loads contacts + email activity.

import { describe, it, expect } from "vitest";
import { selectContactsForEnrichment } from "./enrich-queue";

const NOW = Date.parse("2026-07-19T12:00:00Z");
const days = (n: number) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

const contact = (
  id: string,
  over: Partial<{
    email: string | null;
    summary_generated_at: string | null;
    enriched_at: string | null;
  }> = {},
) => ({
  id,
  email: `${id}@example.com`,
  summary_generated_at: null,
  enriched_at: null,
  ...over,
});

describe("selectContactsForEnrichment", () => {
  it("includes never-summarized contacts and skips contacts without email", () => {
    const picked = selectContactsForEnrichment({
      contacts: [contact("a"), contact("b", { email: null })],
      activity: new Map(),
      now: NOW,
    });
    expect(picked).toEqual(["a"]);
  });

  it("re-enriches only when the summary is stale AND enough new mail arrived", () => {
    const activity = new Map([
      ["stale-active", { newSinceSummary: 6, lastReceivedAt: days(1) }],
      ["stale-quiet", { newSinceSummary: 2, lastReceivedAt: days(2) }],
      ["fresh-active", { newSinceSummary: 50, lastReceivedAt: days(0) }],
    ]);
    const picked = selectContactsForEnrichment({
      contacts: [
        contact("stale-active", { summary_generated_at: days(45) }),
        contact("stale-quiet", { summary_generated_at: days(45) }),
        contact("fresh-active", { summary_generated_at: days(3) }),
      ],
      activity,
      now: NOW,
    });
    expect(picked).toEqual(["stale-active"]);
  });

  it("prioritizes by new-email volume, then recency", () => {
    const activity = new Map([
      ["low", { newSinceSummary: 1, lastReceivedAt: days(1) }],
      ["high", { newSinceSummary: 9, lastReceivedAt: days(5) }],
      ["mid-recent", { newSinceSummary: 4, lastReceivedAt: days(0) }],
      ["mid-old", { newSinceSummary: 4, lastReceivedAt: days(9) }],
    ]);
    const picked = selectContactsForEnrichment({
      contacts: [contact("low"), contact("high"), contact("mid-recent"), contact("mid-old")],
      activity,
      now: NOW,
    });
    expect(picked).toEqual(["high", "mid-recent", "mid-old", "low"]);
  });

  it("caps the per-tick batch", () => {
    const contacts = Array.from({ length: 30 }, (_, i) => contact(`c${i}`));
    const picked = selectContactsForEnrichment({
      contacts,
      activity: new Map(),
      now: NOW,
      caps: { maxPerUser: 5 },
    });
    expect(picked).toHaveLength(5);
  });
});
