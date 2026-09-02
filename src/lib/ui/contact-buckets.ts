// Grouping the address book "by company", lifted out of
// `routes/_authenticated/contacts.index.tsx`.
//
// This is the densest decision on that page: every contact has to land in
// exactly one bucket, and the evidence it is judged on — a linked company row,
// an email domain, a domain alias, a website, a typed-in company name — is
// usually incomplete and often contradictory. The failure modes are all
// visible: the same company rendered as two sections, a gmail-only colleague
// minting a "gmail.com company", or two genuinely different companies folded
// together because their names share a token.

import {
  contactLogoDomain,
  emailDomain,
  isPersonalDomain,
  isRoutableDomain,
  prettyCompanyName,
  resolveCompanyDomain,
} from "@/lib/company-domains";
import { companyBrandKey } from "@/lib/contacts/company-name";

/** The bucket key used for every contact on a personal-mail domain. */
export const PERSONAL_KEY = "__personal__";
/** The bucket key used for every contact with no usable domain at all. */
export const OTHER_KEY = "__other__";

/** The fields bucketing reads off a contact. */
export type BucketContact = {
  id: string;
  email?: string | null;
  website?: string | null;
  company?: string | null;
  company_id?: string | null;
};

export type Bucket<T extends BucketContact = BucketContact> = {
  key: string;
  domain: string | null;
  name: string;
  kind: "company" | "personal" | "other";
  contacts: T[];
  /** Resolved Company entity id, when the bucket is a linked company. */
  companyId?: string;
  /** Custom uploaded company logo URL, when set. */
  companyLogoUrl?: string | null;
};

/** What `buildCompanyBuckets` needs to know about the Company rows. */
export type CompanySummary = { name: string; domain: string | null; logoUrl: string | null };

/** alias domain -> primary domain, from the company_aliases table. */
export function buildAliasMap(
  rows: readonly { alias_domain: string; primary_domain: string }[],
): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of rows) m.set(r.alias_domain, r.primary_domain);
  return m;
}

/** primary domain -> its alias domains, for the company editor. */
export function buildAliasesByPrimary(
  rows: readonly { alias_domain: string; primary_domain: string }[],
): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const r of rows) {
    const arr = m.get(r.primary_domain) ?? [];
    arr.push(r.alias_domain);
    m.set(r.primary_domain, arr);
  }
  return m;
}

/** company id -> display summary. The first domain is the preferred one. */
export function buildCompanyById(
  companies: readonly {
    id: string;
    name: string;
    domains?: { domain: string | null }[] | null;
    logo_url?: string | null;
  }[],
): Map<string, CompanySummary> {
  const m = new Map<string, CompanySummary>();
  for (const c of companies) {
    m.set(c.id, {
      name: c.name,
      domain: c.domains?.[0]?.domain ?? null,
      logoUrl: c.logo_url ?? null,
    });
  }
  return m;
}

/**
 * domain -> company id, over EVERY domain a company owns, not just its first.
 * Lower-cased on the way in because it is looked up with a domain parsed off
 * an email address, which the mail server may have cased however it liked.
 */
export function buildCompanyIdByDomain(
  companies: readonly { id: string; domains?: { domain: string | null }[] | null }[],
): Map<string, string> {
  const m = new Map<string, string>();
  for (const c of companies) {
    for (const d of c.domains ?? []) {
      if (d.domain) m.set(d.domain.toLowerCase(), c.id);
    }
  }
  return m;
}

/**
 * Group contacts into the sections the list renders.
 *
 * The ladder, per contact, in precedence order:
 *
 * 1. **A linked company** — either an explicit `company_id`, or a work domain
 *    that a company already claims. This wins over everything so a colleague
 *    with only a personal address still lands with their team.
 * 2. **A typed-in company name, when there is no email domain at all.** Keyed
 *    by brand, not by the literal string, so "Acme, Inc." and "ACME Inc" meet.
 * 3. **No domain and no name** — the "Other" catch-all.
 * 4. **A personal domain** — one shared "Personal email" section. Personal
 *    domains never seed a bucket's display domain, or a gmail-only member of a
 *    domainless company would turn the section into a "gmail.com company".
 * 5. **A work domain** — a section per domain.
 *
 * Then two passes over the sections: name-keyed sections borrow a domain from
 * the website their members agree on, and any that now match a real domain
 * section (or, with no domain evidence at all, a brand name) fold into it.
 *
 * Output order is companies A–Z, then Personal email, then Other — the two
 * catch-alls sink to the bottom regardless of name.
 */
export function buildCompanyBuckets<T extends BucketContact>({
  contacts,
  aliasMap,
  companyById,
  companyIdByDomain,
}: {
  contacts: readonly T[];
  aliasMap: Map<string, string>;
  companyById: ReadonlyMap<string, CompanySummary>;
  companyIdByDomain: ReadonlyMap<string, string>;
}): Bucket<T>[] {
  const map = new Map<string, Bucket<T>>();
  for (const c of contacts) {
    // Dotless hosts must not become their own bucket (emailDomain no longer
    // filters them; that check now lives in isRoutableDomain).
    const rawDomainRaw = emailDomain(c.email);
    const rawDomain = isRoutableDomain(rawDomainRaw) ? rawDomainRaw : null;
    const d = resolveCompanyDomain(rawDomain, aliasMap);
    const webDomain = contactLogoDomain(c.website, c.email);
    const resolvedWeb = resolveCompanyDomain(webDomain, aliasMap);
    let key: string;
    let bucket: Bucket<T> | undefined;
    const manualCompany = (c.company ?? "").trim();
    const workDomain = d && !isPersonalDomain(d) ? d : null;
    const linkedCompanyId =
      (c.company_id && companyById.has(c.company_id) ? c.company_id : null) ??
      (workDomain ? (companyIdByDomain.get(workDomain) ?? null) : null);
    if (linkedCompanyId) {
      const company = companyById.get(linkedCompanyId)!;
      key = `cid:${linkedCompanyId}`;
      bucket = map.get(key) ?? {
        key,
        domain: company.domain ?? resolvedWeb ?? workDomain,
        name: company.name,
        kind: "company",
        contacts: [],
        companyId: linkedCompanyId,
        companyLogoUrl: company.logoUrl,
      };
    } else if (!d && manualCompany) {
      key = `name:${companyBrandKey(manualCompany)}`;
      bucket = map.get(key) ?? {
        key,
        domain: null,
        name: manualCompany,
        kind: "company",
        contacts: [],
      };
    } else if (!d) {
      key = OTHER_KEY;
      bucket = map.get(key) ?? { key, domain: null, name: "Other", kind: "other", contacts: [] };
    } else if (isPersonalDomain(d)) {
      key = PERSONAL_KEY;
      bucket = map.get(key) ?? {
        key,
        domain: null,
        name: "Personal email",
        kind: "personal",
        contacts: [],
      };
    } else {
      key = d;
      bucket = map.get(key) ?? {
        key,
        domain: resolvedWeb ?? d,
        name: prettyCompanyName(d),
        kind: "company",
        contacts: [],
      };
      // A member's own spelling of the company beats the one derived from the
      // domain, but only while the derived one is still in place — the first
      // contact to supply a real name keeps it.
      if (c.company && bucket.name === prettyCompanyName(d)) bucket.name = c.company;
      if (resolvedWeb && bucket.domain === d) bucket.domain = resolvedWeb;
    }
    bucket.contacts.push(c);
    map.set(key, bucket);
  }

  const arr = Array.from(map.values());
  // For name-keyed buckets (no email domain), derive a domain from the
  // dominant contact website so the edit dialog can key off it.
  for (const b of arr) {
    if (b.kind === "company" && !b.domain && b.key.startsWith("name:")) {
      const domCounts = new Map<string, number>();
      for (const c of b.contacts) {
        const wd = contactLogoDomain(c.website, c.email);
        const rd = wd ? resolveCompanyDomain(wd, aliasMap) : null;
        if (rd && !isPersonalDomain(rd)) {
          domCounts.set(rd, (domCounts.get(rd) ?? 0) + 1);
        }
      }
      let best = 0;
      for (const [d, n] of domCounts) {
        if (n > best) {
          best = n;
          b.domain = d;
        }
      }
    }
  }

  // Collapse name-keyed buckets whose members share a website/email domain
  // with an existing domain bucket (e.g. contacts with no email but a website
  // pointing to nucar.com should merge into the nucar.com bucket). Name-keyed
  // buckets with no derivable domain at all fold into a company bucket with
  // the same normalized name instead — a contact with only "Zimmerman
  // Advertising" typed in must not mint a second company row.
  const byDomain = new Map<string, Bucket<T>>();
  const byNormName = new Map<string, Bucket<T>>();
  for (const b of arr) {
    if (b.kind === "company" && !b.key.startsWith("name:")) {
      if (b.domain) byDomain.set(b.domain, b);
      const norm = companyBrandKey(b.name);
      if (norm && !byNormName.has(norm)) byNormName.set(norm, b);
    }
  }
  const collapsed: Bucket<T>[] = [];
  for (const b of arr) {
    if (b.kind === "company" && b.key.startsWith("name:")) {
      if (b.domain && byDomain.has(b.domain)) {
        byDomain.get(b.domain)!.contacts.push(...b.contacts);
        continue;
      }
      // Name fold only when the bucket has NO domain evidence at all — a
      // derived domain that matches nothing means these contacts belong to a
      // DIFFERENT company that merely shares a brand token ("Apex Group" at
      // apexgroup.com must not fold into "Apex" at apex.com).
      if (!b.domain) {
        const norm = companyBrandKey(b.name);
        if (norm && byNormName.has(norm)) {
          byNormName.get(norm)!.contacts.push(...b.contacts);
          continue;
        }
      }
    }
    collapsed.push(b);
  }

  const companies = collapsed
    .filter((b) => b.kind === "company")
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  const personal = collapsed.filter((b) => b.kind === "personal");
  const other = collapsed.filter((b) => b.kind === "other");
  return [...companies, ...personal, ...other];
}
