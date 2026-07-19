// Find more people at a company from the user's own email + calendar data,
// matched by the company's domains, excluding people already saved as
// contacts. Sender addresses (emails.from_addr) and calendar attendee
// addresses (calendar_contacts.email_address) are plaintext, so they can be
// filtered by domain directly; email recipients (to/cc) are encrypted and not
// covered here.
import { createServerFn } from "@tanstack/react-start";
import { generateText, NoObjectGeneratedError, Output } from "ai";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { createLovableAiGatewayProvider } from "@/lib/ai-gateway";
import { extractDomain, isPersonalDomain } from "@/lib/company-domains";
import { isLikelyHuman } from "@/lib/contacts-helpers.server";
import {
  emailLocalPart,
  firstLastTokens,
  nameMatchConfidence,
  normalizeNameLoose,
} from "@/lib/contacts/name-match";

type PossibleMatch = {
  contactId: string;
  contactName: string | null;
  contactEmail: string | null;
  reason: "name_exact" | "localpart_diff_domain" | "loose_tokens";
  score: number; // 0..1
  sameCompanyId: boolean;
  differentDomain: boolean;
};

type FoundPerson = {
  email: string;
  name: string | null;
  sources: ("email" | "calendar")[];
  count: number;
  lastSeenAt: string | null;
  possibleMatches: PossibleMatch[];
};

/** Title-case a plausible name from an email local part ("john.doe" →
 *  "John Doe"). Returns null when the local part doesn't look name-like. */
function nameFromLocalPart(email: string): string | null {
  const local = email.split("@")[0] ?? "";
  if (!local || /[^a-z0-9._-]/i.test(local)) return null;
  const parts = local.split(/[._-]+/).filter((p) => /^[a-z]+$/i.test(p) && p.length > 1);
  if (parts.length < 2) return null; // single token → likely a handle, not a name
  return parts.map((p) => p[0].toUpperCase() + p.slice(1).toLowerCase()).join(" ");
}

export const findCompanyPeopleByDomain = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ companyId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const { data: company } = await supabase
      .from("companies")
      .select("id")
      .eq("id", data.companyId)
      .eq("user_id", userId)
      .maybeSingle();
    if (!company) throw new Error("Company not found");

    const { data: domainRows } = await supabase
      .from("company_domains")
      .select("domain")
      .eq("user_id", userId)
      .eq("company_id", data.companyId);
    const domains = Array.from(
      new Set(
        (domainRows ?? [])
          .map((d) => (d as { domain: string }).domain.toLowerCase())
          .filter((d) => d && !isPersonalDomain(d)),
      ),
    );
    if (domains.length === 0) return { people: [] as FoundPerson[], domains };

    const domainSet = new Set(domains);
    const emailOr = domains.map((d) => `from_addr.ilike.*@${d}`).join(",");
    const calOr = domains.map((d) => `email_address.ilike.*@${d}`).join(",");

    const [
      { data: mailRows },
      { data: calRows },
      { data: existing },
      { data: extraEmails },
      { data: accts },
    ] = await Promise.all([
      supabase
        .from("emails")
        .select("from_addr,received_at")
        .eq("user_id", userId)
        .not("from_addr", "is", null)
        .or(emailOr)
        .order("received_at", { ascending: false })
        .limit(5000),
      supabase
        .from("calendar_contacts")
        .select("email_address,last_seen_at")
        .eq("user_id", userId)
        .or(calOr)
        .limit(5000),
      supabase
        .from("contacts")
        .select("id,name,email,company_id")
        .eq("user_id", userId),
      supabase
        .from("contact_emails")
        .select("contact_id,address")
        .eq("user_id", userId),
      supabase.from("gmail_accounts").select("email_address").eq("user_id", userId),
    ]);

    type ContactRow = {
      id: string;
      name: string | null;
      email: string | null;
      company_id: string | null;
    };
    const contactsById = new Map<string, ContactRow>();
    const exclude = new Set<string>();
    for (const c of (existing ?? []) as ContactRow[]) {
      contactsById.set(c.id, c);
      const e = (c.email || "").toLowerCase();
      if (e) exclude.add(e);
    }
    // Aggregate all emails per contact (primary + secondary) for local-part matching.
    const emailsByContact = new Map<string, string[]>();
    for (const c of contactsById.values()) {
      if (c.email) emailsByContact.set(c.id, [c.email.toLowerCase()]);
    }
    for (const r of (extraEmails ?? []) as Array<{ contact_id: string; address: string | null }>) {
      const addr = (r.address || "").toLowerCase();
      if (!addr) continue;
      exclude.add(addr);
      const arr = emailsByContact.get(r.contact_id) ?? [];
      if (!arr.includes(addr)) arr.push(addr);
      emailsByContact.set(r.contact_id, arr);
    }
    for (const a of accts ?? []) {
      const e = ((a as { email_address: string | null }).email_address || "").toLowerCase();
      if (e) exclude.add(e);
    }

    // Match indexes: normalized full name → contactIds; localPart → contactIds.
    const byName = new Map<string, string[]>();
    const byLocal = new Map<string, string[]>();
    for (const c of contactsById.values()) {
      const norm = normalizeNameLoose(c.name);
      if (norm) {
        const arr = byName.get(norm) ?? [];
        arr.push(c.id);
        byName.set(norm, arr);
      }
      for (const addr of emailsByContact.get(c.id) ?? []) {
        const lp = emailLocalPart(addr);
        if (!lp) continue;
        const arr = byLocal.get(lp) ?? [];
        if (!arr.includes(c.id)) arr.push(c.id);
        byLocal.set(lp, arr);
      }
    }

    // Track the best from_name/display_name we've seen for each candidate email.
    const bestNameByEmail = new Map<string, string>();
    const agg = new Map<string, FoundPerson>();
    const consider = (
      addr: string,
      source: "email" | "calendar",
      at: string | null,
      displayName: string | null,
    ) => {
      const email = addr.trim().toLowerCase();
      if (!email || exclude.has(email) || !isLikelyHuman(email)) return;
      const dom = extractDomain(email);
      if (!dom || !domainSet.has(dom)) return; // exact-domain guard (no subdomains)
      if (displayName && displayName.trim() && !bestNameByEmail.has(email)) {
        bestNameByEmail.set(email, displayName.trim());
      }
      const cur = agg.get(email);
      if (!cur) {
        agg.set(email, {
          email,
          name: displayName?.trim() || nameFromLocalPart(email),
          sources: [source],
          count: 1,
          lastSeenAt: at,
          possibleMatches: [],
        });
      } else {
        cur.count++;
        if (!cur.name && displayName?.trim()) cur.name = displayName.trim();
        if (!cur.sources.includes(source)) cur.sources.push(source);
        if (at && (!cur.lastSeenAt || at > cur.lastSeenAt)) cur.lastSeenAt = at;
      }
    };

    for (const r of mailRows ?? []) {
      const row = r as { from_addr: string; received_at: string | null };
      consider(row.from_addr, "email", row.received_at, null);
    }
    for (const r of calRows ?? []) {
      const row = r as { email_address: string; last_seen_at: string | null };
      consider(row.email_address, "calendar", row.last_seen_at, null);
    }

    // Score possible matches for each candidate against existing contacts.
    for (const person of agg.values()) {
      const candidateName = bestNameByEmail.get(person.email) ?? person.name;
      const candidateLocal = emailLocalPart(person.email);
      const candidateDom = extractDomain(person.email);
      const seen = new Map<string, PossibleMatch>();
      const upsertMatch = (m: PossibleMatch) => {
        const prev = seen.get(m.contactId);
        if (!prev || m.score > prev.score) seen.set(m.contactId, m);
      };

      // Name-based matches.
      if (candidateName) {
        const nn = normalizeNameLoose(candidateName);
        for (const id of byName.get(nn) ?? []) {
          const c = contactsById.get(id);
          if (!c) continue;
          upsertMatch({
            contactId: id,
            contactName: c.name,
            contactEmail: c.email,
            reason: "name_exact",
            score: 0.95,
            sameCompanyId: c.company_id === data.companyId,
            differentDomain: !c.email || extractDomain(c.email) !== candidateDom,
          });
        }
        // Loose name matches across all contacts (bounded scan).
        for (const c of contactsById.values()) {
          if (seen.has(c.id)) continue;
          const conf = nameMatchConfidence(candidateName, c.name, 3);
          if (!conf) continue;
          upsertMatch({
            contactId: c.id,
            contactName: c.name,
            contactEmail: c.email,
            reason: "loose_tokens",
            score: conf === "high" ? 0.9 : conf === "medium" ? 0.7 : 0.5,
            sameCompanyId: c.company_id === data.companyId,
            differentDomain: !c.email || extractDomain(c.email) !== candidateDom,
          });
        }
      }

      // Local-part matches on a different domain.
      if (candidateLocal) {
        for (const id of byLocal.get(candidateLocal) ?? []) {
          const c = contactsById.get(id);
          if (!c) continue;
          const contactAddrs = emailsByContact.get(id) ?? [];
          const sameLocalDifferentDomain = contactAddrs.every(
            (a) => extractDomain(a) !== candidateDom,
          );
          if (!sameLocalDifferentDomain) continue;
          upsertMatch({
            contactId: id,
            contactName: c.name,
            contactEmail: c.email,
            reason: "localpart_diff_domain",
            score: 0.75,
            sameCompanyId: c.company_id === data.companyId,
            differentDomain: true,
          });
        }
      }

      person.possibleMatches = [...seen.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);
    }

    // Optional AI disambiguation when the top two matches tie on score. Best-effort.
    const key = process.env.LOVABLE_API_KEY;
    if (key) {
      const needsAI = [...agg.values()].filter(
        (p) =>
          p.possibleMatches.length >= 2 &&
          p.possibleMatches[0].score === p.possibleMatches[1].score,
      );
      if (needsAI.length > 0 && needsAI.length <= 20) {
        try {
          const model = createLovableAiGatewayProvider(key)("google/gemini-3.1-flash-lite");
          const schema = z.object({
            picks: z.array(
              z.object({
                email: z.string(),
                bestContactId: z.string().nullable(),
              }),
            ),
          });
          const prompt = `For each candidate email, choose the best matching existing contact by identity (same real person), or null if none clearly match. Return one entry per candidate.\n\nCandidates:\n${needsAI
            .map((p) => {
              const cands = p.possibleMatches
                .map(
                  (m) =>
                    `    - id=${m.contactId} name=${JSON.stringify(m.contactName)} email=${JSON.stringify(m.contactEmail)}`,
                )
                .join("\n");
              return `- email=${p.email} candidateName=${JSON.stringify(bestNameByEmail.get(p.email) ?? p.name)}\n  possible:\n${cands}`;
            })
            .join("\n")}`;
          const { output } = await generateText({
            model,
            output: Output.object({ schema }),
            prompt,
          });
          const pickByEmail = new Map(
            output.picks.map((p) => [p.email.toLowerCase(), p.bestContactId]),
          );
          for (const p of needsAI) {
            const pick = pickByEmail.get(p.email);
            if (!pick) continue;
            const idx = p.possibleMatches.findIndex((m) => m.contactId === pick);
            if (idx > 0) {
              const [chosen] = p.possibleMatches.splice(idx, 1);
              chosen.score = Math.max(chosen.score, 0.92);
              p.possibleMatches.unshift(chosen);
            }
          }
        } catch (e) {
          if (!NoObjectGeneratedError.isInstance(e)) {
            console.error("AI tie-break failed", (e as Error).message);
          }
        }
      }
    }

    const people = [...agg.values()].sort(
      (a, b) => b.count - a.count || (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? ""),
    );
    return { people: people.slice(0, 200), domains };
  });

export const enhanceContactWithNewEmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        contactId: z.string().uuid(),
        companyId: z.string().uuid(),
        email: z.string().trim().toLowerCase().email().max(255),
        name: z.string().trim().max(200).nullable().optional(),
        mode: z.enum(["replace_primary", "add_secondary"]).default("add_secondary"),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const { data: contact, error: cErr } = await supabase
      .from("contacts")
      .select("id,email,name,company,company_id")
      .eq("id", data.contactId)
      .eq("user_id", userId)
      .maybeSingle();
    if (cErr) throw new Error(cErr.message);
    if (!contact) throw new Error("Contact not found");

    const { data: company } = await supabase
      .from("companies")
      .select("id,name")
      .eq("id", data.companyId)
      .eq("user_id", userId)
      .maybeSingle();
    if (!company) throw new Error("Company not found");
    const companyName = (company as { name: string }).name;

    // Make sure the new email isn't already a different contact.
    const { data: clash } = await supabase
      .from("contacts")
      .select("id")
      .eq("user_id", userId)
      .eq("email", data.email)
      .neq("id", data.contactId)
      .maybeSingle();
    if (clash) throw new Error("Another contact already uses that email");

    const row = contact as {
      id: string;
      email: string | null;
      name: string | null;
      company: string | null;
      company_id: string | null;
    };

    if (data.mode === "replace_primary") {
      // Preserve the old primary as a secondary so history isn't lost.
      const oldPrimary = (row.email || "").toLowerCase();
      const patch: {
        email: string;
        company: string;
        company_id: string;
        name?: string;
      } = {
        email: data.email,
        company: companyName,
        company_id: data.companyId,
      };
      if (!row.name && data.name) patch.name = data.name;
      const { error: upErr } = await supabase
        .from("contacts")
        .update(patch)
        .eq("id", row.id)
        .eq("user_id", userId);
      if (upErr) throw new Error(upErr.message);
      if (oldPrimary && oldPrimary !== data.email) {
        await supabase
          .from("contact_emails")
          .insert({
            user_id: userId,
            contact_id: row.id,
            address: oldPrimary,
            is_primary: false,
          });
      }
    } else {
      // Add-as-secondary. If contact has no primary, promote this to primary.
      if (!row.email) {
        const patch: {
          email: string;
          company: string;
          company_id: string;
          name?: string;
        } = {
          email: data.email,
          company: companyName,
          company_id: data.companyId,
        };
        if (!row.name && data.name) patch.name = data.name;
        const { error: upErr } = await supabase
          .from("contacts")
          .update(patch)
          .eq("id", row.id)
          .eq("user_id", userId);
        if (upErr) throw new Error(upErr.message);
      } else {
        // Attach secondary + link company if missing.
        if (!row.company_id) {
          await supabase
            .from("contacts")
            .update({ company: companyName, company_id: data.companyId })
            .eq("id", row.id)
            .eq("user_id", userId);
        }
        const { error: seErr } = await supabase.from("contact_emails").insert({
          user_id: userId,
          contact_id: row.id,
          address: data.email,
          is_primary: false,
        });
        // Ignore duplicate-key collisions from a re-run.
        if (seErr && !/duplicate|unique/i.test(seErr.message)) {
          throw new Error(seErr.message);
        }
      }
    }

    // Converge label rules + auto-subgroups just like addCompanyPeople.
    try {
      const { syncCompanyRuleMemberships } = await import(
        "@/lib/contacts/group-rules.functions"
      );
      await syncCompanyRuleMemberships(supabase, userId, {
        companyIds: [data.companyId],
        contactIds: [row.id],
        bumpResync: true,
      });
    } catch {
      // Non-fatal.
    }
    try {
      const { reconcileAutoParentsForContacts } = await import(
        "@/lib/contacts/auto-company-subgroups.functions"
      );
      await reconcileAutoParentsForContacts(supabase, userId, [row.id]);
    } catch {
      // Non-fatal.
    }

    return { contactId: row.id };
  });


export const addCompanyPeople = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        companyId: z.string().uuid(),
        items: z
          .array(
            z.object({
              email: z.string().trim().toLowerCase().email().max(255),
              name: z.string().trim().max(200).nullable().optional(),
            }),
          )
          .min(1)
          .max(200),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: company } = await supabase
      .from("companies")
      .select("id,name")
      .eq("id", data.companyId)
      .eq("user_id", userId)
      .maybeSingle();
    if (!company) throw new Error("Company not found");
    const companyName = (company as { name: string }).name;

    // The contacts table has no plain unique constraint on (user_id, email) —
    // only a partial functional unique index on (user_id, lower(email)) WHERE
    // email IS NOT NULL. PostgREST's ON CONFLICT can't target that, so we
    // dedupe explicitly: fetch existing, update those, insert the rest.
    const emails = Array.from(new Set(data.items.map((it) => it.email)));
    const nameByEmail = new Map<string, string | null>();
    for (const it of data.items) {
      if (!nameByEmail.has(it.email)) nameByEmail.set(it.email, it.name || null);
    }

    const { data: existingRows, error: exErr } = await supabase
      .from("contacts")
      .select("id,email,company_id,name")
      .eq("user_id", userId)
      .in("email", emails);
    if (exErr) throw new Error(exErr.message);

    const existingByEmail = new Map<string, { id: string; company_id: string | null; name: string | null }>();
    for (const r of (existingRows ?? []) as Array<{
      id: string;
      email: string | null;
      company_id: string | null;
      name: string | null;
    }>) {
      const e = (r.email || "").toLowerCase();
      if (e) existingByEmail.set(e, { id: r.id, company_id: r.company_id, name: r.name });
    }

    const contactIds: string[] = [];

    // Update contacts that already exist but aren't linked to a company yet.
    const toUpdate = [...existingByEmail.entries()].filter(([, r]) => !r.company_id);
    for (const [email, row] of toUpdate) {
      const n = !row.name ? nameByEmail.get(email) ?? null : null;
      const patch = n
        ? { company: companyName, company_id: data.companyId, name: n }
        : { company: companyName, company_id: data.companyId };
      const { error: upErr } = await supabase
        .from("contacts")
        .update(patch)
        .eq("id", row.id)
        .eq("user_id", userId);
      if (upErr) throw new Error(upErr.message);
      contactIds.push(row.id);
    }

    // Existing rows already assigned to another company are left alone.

    // Insert net-new contacts.
    const toInsert = data.items.filter((it) => !existingByEmail.has(it.email));
    if (toInsert.length > 0) {
      const { data: inserted, error: insErr } = await supabase
        .from("contacts")
        .insert(
          toInsert.map((it) => ({
            user_id: userId,
            email: it.email,
            name: it.name || null,
            company: companyName,
            company_id: data.companyId,
            source: "email",
          })),
        )
        .select("id");
      if (insErr) throw new Error(insErr.message);
      for (const r of (inserted ?? []) as Array<{ id: string }>) contactIds.push(r.id);
    }


    // Converge: label rules for the company now apply to the new contacts,
    // domains re-derive, auto-subgroups reconcile. Best-effort.
    if (contactIds.length > 0) {
      try {
        const { syncCompanyRuleMemberships } = await import("@/lib/contacts/group-rules.functions");
        await syncCompanyRuleMemberships(supabase, userId, {
          companyIds: [data.companyId],
          contactIds,
          bumpResync: true,
        });
      } catch {
        // Non-fatal.
      }
      try {
        const { reconcileAutoParentsForContacts } =
          await import("@/lib/contacts/auto-company-subgroups.functions");
        await reconcileAutoParentsForContacts(supabase, userId, contactIds);
      } catch {
        // Non-fatal.
      }
    }
    return { added: contactIds.length };
  });
