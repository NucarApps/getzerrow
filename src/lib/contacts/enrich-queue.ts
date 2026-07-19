// Pure selection of which contacts get a background bio-enrichment job
// this tick. Cost control lives here: never-summarized contacts are always
// candidates; already-summarized ones re-run only when the summary is stale
// AND the contact has meaningful new email volume since it was written.

export type EnrichCandidate = {
  id: string;
  email: string | null;
  summary_generated_at: string | null;
  enriched_at: string | null;
};

export type EmailActivity = {
  /** Emails from this contact since summary_generated_at (or ever). */
  newSinceSummary: number;
  lastReceivedAt: string | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function selectContactsForEnrichment(input: {
  contacts: EnrichCandidate[];
  activity: Map<string, EmailActivity>;
  now: number;
  caps?: { maxPerUser?: number; staleAfterDays?: number; minNewEmails?: number };
}): string[] {
  const maxPerUser = input.caps?.maxPerUser ?? 20;
  const staleAfterMs = (input.caps?.staleAfterDays ?? 30) * DAY_MS;
  const minNewEmails = input.caps?.minNewEmails ?? 5;

  const eligible = input.contacts.filter((c) => {
    if (!c.email) return false;
    if (!c.summary_generated_at) return true;
    const age = input.now - new Date(c.summary_generated_at).getTime();
    if (age < staleAfterMs) return false;
    const activity = input.activity.get(c.id);
    return (activity?.newSinceSummary ?? 0) >= minNewEmails;
  });

  return eligible
    .sort((a, b) => {
      const aa = input.activity.get(a.id);
      const ba = input.activity.get(b.id);
      const volume = (ba?.newSinceSummary ?? 0) - (aa?.newSinceSummary ?? 0);
      if (volume !== 0) return volume;
      const at = aa?.lastReceivedAt ? new Date(aa.lastReceivedAt).getTime() : 0;
      const bt = ba?.lastReceivedAt ? new Date(ba.lastReceivedAt).getTime() : 0;
      return bt - at;
    })
    .slice(0, maxPerUser)
    .map((c) => c.id);
}
