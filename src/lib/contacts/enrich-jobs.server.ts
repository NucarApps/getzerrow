// Background contact-enrichment queue: enqueue pass (cron, every 15min)
// selects contacts needing an AI bio and users due for a group-suggestion
// scan; worker pass (cron, every 2min) claims jobs via SKIP-LOCKED RPC and
// runs them with supabaseAdmin. Every reused core fn takes an explicit
// userId — admin-client calls must never rely on RLS for scoping.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { logInfo, logError } from "@/lib/log.server";
import { isPersonalDomain } from "@/lib/company-domains";
import { selectContactsForEnrichment, type EmailActivity } from "./enrich-queue";
import { evaluateAutoApply } from "./suggestion-confidence";
import { deriveLabelKey } from "./label-resolve";

// contact_enrich_jobs is not in the generated Supabase types yet
// (regenerate after applying migration 20260719150200) — go through an
// untyped accessor until then.
const enrichJobsTable = () =>
  (supabaseAdmin as unknown as import("@supabase/supabase-js").SupabaseClient).from(
    "contact_enrich_jobs",
  );

const MAX_USERS_PER_ENQUEUE = 20;
const MAX_BIO_JOBS_PER_USER_PER_TICK = 20;
const MAX_BIO_JOBS_PER_USER_PER_DAY = 50;
const SUGGEST_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MIN_CONTACTS_FOR_SUGGEST = 5;
const ACTIVITY_WINDOW_DAYS = 45;

export type UserScanKind = "dedup_scan" | "signature_scan";

/** Queue a whole-user AI scan (duplicate detection / signature enrichment)
 * for the 2-minute worker. Idempotent: the partial unique index on live
 * jobs makes a second enqueue while one is pending/running a no-op. */
export async function enqueueUserScanJob(
  userId: string,
  kind: UserScanKind,
): Promise<{ queued: boolean; alreadyQueued: boolean }> {
  const { error } = await enrichJobsTable().insert({
    user_id: userId,
    kind,
    contact_id: null,
    status: "pending",
  } as never);
  if (error) {
    // 23505 = unique violation on the live-job index → a scan is already
    // queued or running; treat as success so the UI just starts polling.
    if ((error as { code?: string }).code === "23505") {
      return { queued: false, alreadyQueued: true };
    }
    throw new Error(error.message);
  }
  logInfo("contact_enrich.scan_enqueued", { user_id: userId, kind });
  return { queued: true, alreadyQueued: false };
}

type Db = typeof supabaseAdmin;

async function loadEmailActivity(
  db: Db,
  userId: string,
  contacts: Array<{ id: string; email: string | null; summary_generated_at: string | null }>,
): Promise<Map<string, EmailActivity>> {
  const since = new Date(Date.now() - ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data: rows } = await db
    .from("emails")
    .select("from_addr, received_at")
    .eq("user_id", userId)
    .gte("received_at", since)
    .order("received_at", { ascending: false })
    .limit(5000);
  const byAddr = new Map<string, Array<string>>();
  for (const r of (rows ?? []) as Array<{ from_addr: string | null; received_at: string }>) {
    if (!r.from_addr) continue;
    const key = r.from_addr.toLowerCase();
    const arr = byAddr.get(key) ?? [];
    arr.push(r.received_at);
    byAddr.set(key, arr);
  }
  const activity = new Map<string, EmailActivity>();
  for (const c of contacts) {
    if (!c.email) continue;
    const received = byAddr.get(c.email.toLowerCase()) ?? [];
    const cutoff = c.summary_generated_at ? new Date(c.summary_generated_at).getTime() : 0;
    const fresh = received.filter((ts) => new Date(ts).getTime() > cutoff);
    activity.set(c.id, {
      newSinceSummary: fresh.length,
      lastReceivedAt: received[0] ?? null,
    });
  }
  return activity;
}

export async function enqueueContactEnrichment(): Promise<{
  users: number;
  bioJobs: number;
  suggestJobs: number;
}> {
  // Users with connected mail are the enrichment population.
  const { data: accounts, error: accErr } = await supabaseAdmin
    .from("gmail_accounts")
    .select("user_id");
  if (accErr) throw new Error(accErr.message);
  const userIds = [...new Set((accounts ?? []).map((a) => a.user_id as string))].slice(
    0,
    MAX_USERS_PER_ENQUEUE,
  );

  let bioJobs = 0;
  let suggestJobs = 0;
  for (const userId of userIds) {
    try {
      const { data: contacts } = await supabaseAdmin
        .from("contacts")
        .select("id,email,summary_generated_at,enriched_at")
        .eq("user_id", userId)
        .not("email", "is", null)
        .limit(5000);
      const candidates = (contacts ?? []) as Array<{
        id: string;
        email: string | null;
        summary_generated_at: string | null;
        enriched_at: string | null;
      }>;
      if (candidates.length === 0) continue;

      // Existing live jobs make enqueue idempotent (a partial unique index
      // backs this up, but batch inserts fail wholesale on conflict — so
      // filter first).
      const { data: liveJobs } = await enrichJobsTable()
        .select("kind, contact_id")
        .eq("user_id", userId)
        .in("status", ["pending", "running"]);
      const liveBio = new Set(
        ((liveJobs ?? []) as Array<{ kind: string; contact_id: string | null }>)
          .filter((j) => j.kind === "bio" && j.contact_id)
          .map((j) => j.contact_id as string),
      );
      const hasLiveSuggest = ((liveJobs ?? []) as Array<{ kind: string }>).some(
        (j) => j.kind === "suggest",
      );

      // Daily cost cap on bios.
      const dayStart = new Date();
      dayStart.setUTCHours(0, 0, 0, 0);
      const { count: doneToday } = await enrichJobsTable()
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("kind", "bio")
        .gte("finished_at", dayStart.toISOString());
      const dailyBudget = Math.max(0, MAX_BIO_JOBS_PER_USER_PER_DAY - (doneToday ?? 0));

      const activity = await loadEmailActivity(supabaseAdmin, userId, candidates);
      const picked = selectContactsForEnrichment({
        contacts: candidates,
        activity,
        now: Date.now(),
        caps: { maxPerUser: Math.min(MAX_BIO_JOBS_PER_USER_PER_TICK, dailyBudget) },
      }).filter((id) => !liveBio.has(id));

      if (picked.length > 0) {
        const { error: insErr } = await enrichJobsTable().insert(
          picked.map((contactId) => ({
            user_id: userId,
            kind: "bio",
            contact_id: contactId,
          })) as never[],
        );
        if (!insErr) bioJobs += picked.length;
      }

      // One suggest scan per user per day, only when there's enough signal.
      if (!hasLiveSuggest && candidates.length >= MIN_CONTACTS_FOR_SUGGEST) {
        const { data: lastSuggest } = await enrichJobsTable()
          .select("finished_at")
          .eq("user_id", userId)
          .eq("kind", "suggest")
          .not("finished_at", "is", null)
          .order("finished_at", { ascending: false })
          .limit(1);
        const last = (lastSuggest ?? [])[0]?.finished_at as string | undefined;
        if (!last || Date.now() - new Date(last).getTime() > SUGGEST_INTERVAL_MS) {
          const { error: insErr } = await enrichJobsTable().insert({
            user_id: userId,
            kind: "suggest",
          } as never);
          if (!insErr) suggestJobs++;
        }
      }
    } catch (e) {
      logError("contact_enrich.enqueue_user_failed", { user_id: userId }, e);
    }
  }
  logInfo("contact_enrich.enqueue_done", {
    users: userIds.length,
    bio_jobs: bioJobs,
    suggest_jobs: suggestJobs,
  });
  return { users: userIds.length, bioJobs, suggestJobs };
}

/** Auto-apply gate over the freshest pending suggestions for one user.
 * Deterministic evidence decides (see suggestion-confidence.ts); applies
 * create a durable rule so the grouping keeps itself current. */
async function autoApplyHighConfidenceSuggestions(
  userId: string,
): Promise<{ applied: number; considered: number }> {
  const { data: pending } = await supabaseAdmin
    .from("contact_group_suggestions")
    .select("id,name,kind,contact_ids,existing_group_id,confidence")
    .eq("user_id", userId)
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(20);
  const rows = (pending ?? []) as unknown as Array<{
    id: string;
    name: string;
    kind: string;
    contact_ids: string[];
    existing_group_id: string | null;
    confidence: string | null;
  }>;
  const high = rows.filter((r) => r.confidence === "high");
  if (high.length === 0) return { applied: 0, considered: rows.length };

  const memberIds = [...new Set(high.flatMap((r) => r.contact_ids ?? []))];
  const [{ data: contacts }, { data: domains }, { data: companies }] = await Promise.all([
    supabaseAdmin
      .from("contacts")
      .select("id,email,company_id")
      .eq("user_id", userId)
      .in("id", memberIds.length > 0 ? memberIds : ["00000000-0000-0000-0000-000000000000"]),
    supabaseAdmin.from("company_domains").select("domain,company_id").eq("user_id", userId),
    supabaseAdmin
      .from("companies")
      .select("id,name,name_key,linked_group_id")
      .eq("user_id", userId),
  ]);

  const companyIdByContact = new Map<string, string | null>();
  const domainByContact = new Map<string, string | null>();
  for (const c of (contacts ?? []) as Array<{
    id: string;
    email: string | null;
    company_id: string | null;
  }>) {
    companyIdByContact.set(c.id, c.company_id);
    const at = c.email?.lastIndexOf("@") ?? -1;
    domainByContact.set(c.id, at > 0 ? c.email!.slice(at + 1).toLowerCase() : null);
  }
  const companyIdByDomain = new Map<string, string>();
  for (const d of (domains ?? []) as Array<{ domain: string; company_id: string }>) {
    companyIdByDomain.set(d.domain.toLowerCase(), d.company_id);
  }
  const companyRows = (companies ?? []) as Array<{
    id: string;
    name: string;
    name_key: string | null;
    linked_group_id: string | null;
  }>;
  const companyByLinkedGroup = new Map(
    companyRows.filter((c) => c.linked_group_id).map((c) => [c.linked_group_id as string, c.id]),
  );
  const companyByKey = new Map<string, string>();
  for (const c of companyRows) {
    const key = deriveLabelKey(c.name).key;
    if (key && !companyByKey.has(key)) companyByKey.set(key, c.id);
  }

  let applied = 0;
  for (const s of high) {
    const nameKey = deriveLabelKey(s.name).key;
    const result = evaluateAutoApply(
      { contact_ids: s.contact_ids ?? [], confidence: "high" },
      {
        companyIdByContact,
        domainByContact,
        isPersonalDomain: (d) => isPersonalDomain(d),
        companyIdByDomain,
        targetLabelCompanyId: s.existing_group_id
          ? (companyByLinkedGroup.get(s.existing_group_id) ?? null)
          : null,
        suggestionNameCompanyId: nameKey ? (companyByKey.get(nameKey) ?? null) : null,
      },
    );
    if (!result.autoApply) {
      logInfo("contact_enrich.suggest_not_auto_applied", {
        user_id: userId,
        suggestion_id: s.id,
        reason: result.reason,
      });
      continue;
    }
    try {
      const { applySuggestionImpl } = await import("./suggest-groups.functions");
      const appliedRes = await applySuggestionImpl(supabaseAdmin, userId, {
        id: s.id,
        autoApplied: true,
        evidence: { reason: result.reason, ...result.evidence },
      });
      // Durable rule: future contacts matching the evidence join on their own.
      if (appliedRes.group_id && result.rule) {
        await supabaseAdmin.from("contact_group_rules").upsert(
          {
            user_id: userId,
            group_id: appliedRes.group_id,
            rule_type: result.rule.ruleType,
            value: result.rule.value,
            auto_apply: true,
          } as never,
          { onConflict: "group_id,rule_type,value" },
        );
        if (result.rule.ruleType === "company_id") {
          const { syncCompanyRuleMemberships } = await import("./group-rules.functions");
          await syncCompanyRuleMemberships(supabaseAdmin, userId, {
            companyIds: [result.rule.value],
            bumpResync: true,
          });
        }
      }
      applied++;
      logInfo("contact_enrich.suggest_auto_applied", {
        user_id: userId,
        suggestion_id: s.id,
        reason: result.reason,
        group_id: appliedRes.group_id,
      });
    } catch (e) {
      logError(
        "contact_enrich.suggest_auto_apply_failed",
        { user_id: userId, suggestion_id: s.id },
        e,
      );
    }
  }
  return { applied, considered: rows.length };
}

export async function processContactEnrichJobs(limit: number): Promise<{
  processed: number;
  succeeded: number;
  failed: number;
  autoApplied: number;
}> {
  const { data: claimed, error } = await supabaseAdmin.rpc(
    "claim_contact_enrich_jobs" as never,
    {
      p_limit: limit,
    } as never,
  );
  if (error) throw new Error(error.message);
  const jobs = (claimed ?? []) as unknown as Array<{
    id: string;
    user_id: string;
    kind: "bio" | "suggest" | "dedup_scan" | "signature_scan";
    contact_id: string | null;
  }>;

  let succeeded = 0;
  let failed = 0;
  let autoApplied = 0;

  for (const job of jobs) {
    const finish = async (ok: boolean, errMsg?: string) => {
      await enrichJobsTable()
        .update({
          status: ok ? "done" : "failed",
          error: ok ? null : (errMsg ?? "Unknown error").slice(0, 500),
          finished_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        } as never)
        .eq("id", job.id);
    };
    try {
      if (job.kind === "bio" && job.contact_id) {
        const { runEnrichForContact } = await import("./enrich.functions");
        await runEnrichForContact(
          { supabase: supabaseAdmin, userId: job.user_id },
          job.contact_id,
          false,
        );
      } else if (job.kind === "suggest") {
        const { runContactGroupSuggestionsImpl } = await import("./suggest-groups.functions");
        try {
          await runContactGroupSuggestionsImpl(supabaseAdmin, job.user_id, {
            source: "background",
          });
        } catch (e) {
          // The 5-minute rescan cooldown is not a failure — still gate
          // whatever pending suggestions exist.
          if (!(e instanceof Error && /wait \d+s/i.test(e.message))) throw e;
        }
        const gate = await autoApplyHighConfidenceSuggestions(job.user_id);
        autoApplied += gate.applied;
      } else if (job.kind === "dedup_scan") {
        const { scanContactDuplicatesImpl } = await import("./dedup.functions");
        await scanContactDuplicatesImpl(job.user_id);
      } else if (job.kind === "signature_scan") {
        const { scanContactEnrichmentImpl } = await import("./enrich-suggest.functions");
        await scanContactEnrichmentImpl(supabaseAdmin, job.user_id);
      }
      await finish(true);
      succeeded++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logError("contact_enrich.job_failed", { job_id: job.id, kind: job.kind }, e);
      await finish(false, msg);
      failed++;
    }
  }

  return { processed: jobs.length, succeeded, failed, autoApplied };
}
