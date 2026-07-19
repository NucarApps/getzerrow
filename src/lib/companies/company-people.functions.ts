// Find more people at a company from the user's own email + calendar data,
// matched by the company's domains, excluding people already saved as
// contacts. Sender addresses (emails.from_addr) and calendar attendee
// addresses (calendar_contacts.email_address) are plaintext, so they can be
// filtered by domain directly; email recipients (to/cc) are encrypted and not
// covered here.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { extractDomain, isPersonalDomain } from "@/lib/company-domains";
import { isLikelyHuman } from "@/lib/contacts-helpers.server";

type FoundPerson = {
  email: string;
  name: string | null;
  sources: ("email" | "calendar")[];
  count: number;
  lastSeenAt: string | null;
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
      supabase.from("contacts").select("email").eq("user_id", userId),
      supabase.from("contact_emails").select("address").eq("user_id", userId),
      supabase.from("gmail_accounts").select("email_address").eq("user_id", userId),
    ]);

    // Addresses to exclude: already a contact (primary or secondary) or one of
    // the user's own connected accounts.
    const exclude = new Set<string>();
    for (const c of existing ?? []) {
      const e = ((c as { email: string | null }).email || "").toLowerCase();
      if (e) exclude.add(e);
    }
    for (const c of extraEmails ?? []) {
      const e = ((c as { address: string | null }).address || "").toLowerCase();
      if (e) exclude.add(e);
    }
    for (const a of accts ?? []) {
      const e = ((a as { email_address: string | null }).email_address || "").toLowerCase();
      if (e) exclude.add(e);
    }

    const agg = new Map<string, FoundPerson>();
    const consider = (addr: string, source: "email" | "calendar", at: string | null) => {
      const email = addr.trim().toLowerCase();
      if (!email || exclude.has(email) || !isLikelyHuman(email)) return;
      const dom = extractDomain(email);
      if (!dom || !domainSet.has(dom)) return; // exact-domain guard (no subdomains)
      const cur = agg.get(email);
      if (!cur) {
        agg.set(email, {
          email,
          name: nameFromLocalPart(email),
          sources: [source],
          count: 1,
          lastSeenAt: at,
        });
      } else {
        cur.count++;
        if (!cur.sources.includes(source)) cur.sources.push(source);
        if (at && (!cur.lastSeenAt || at > cur.lastSeenAt)) cur.lastSeenAt = at;
      }
    };

    for (const r of mailRows ?? []) {
      consider(
        (r as { from_addr: string }).from_addr,
        "email",
        (r as { received_at: string | null }).received_at,
      );
    }
    for (const r of calRows ?? []) {
      consider(
        (r as { email_address: string }).email_address,
        "calendar",
        (r as { last_seen_at: string | null }).last_seen_at,
      );
    }

    const people = [...agg.values()].sort(
      (a, b) => b.count - a.count || (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? ""),
    );
    return { people: people.slice(0, 200), domains };
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
      const patch: Record<string, unknown> = {
        company: companyName,
        company_id: data.companyId,
      };
      if (!row.name) {
        const n = nameByEmail.get(email);
        if (n) patch.name = n;
      }
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
