import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { RouteErrorFallback } from "@/components/RouteErrorFallback";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ScanLine,
  Search,
  IdCard,
  Plus,
  Pencil,
  Lock,
  Building2,
  Sparkles,
  Settings2,
  ChevronsDownUp,
  ChevronsUpDown,
  X,
} from "lucide-react";
import { GroupSuggestionsDrawer } from "@/components/contacts/GroupSuggestionsDrawer";
import { GroupEditorDialog, type GroupRow } from "@/components/contacts/GroupEditorDialog";
import { buildDescendantsById, buildGroupTree } from "@/lib/contacts/group-tree";
import { DuplicateSuggestionsDrawer } from "@/components/contacts/DuplicateSuggestionsDrawer";
import { MergeContactsDialog } from "@/components/contacts/MergeContactsDialog";
import { LabelDuplicatesDrawer } from "@/components/contacts/LabelDuplicatesDrawer";
import { EnrichmentSuggestionsDrawer } from "@/components/contacts/EnrichmentSuggestionsDrawer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { listContacts } from "@/lib/contacts.functions";
import { listContactGroups, addContactsToGroups } from "@/lib/contact-groups.functions";
import { reconcileAllAutoGroups } from "@/lib/contacts/auto-company-subgroups.functions";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { toast } from "sonner";
import { CompanyLogo } from "@/components/contacts/CompanyLogo";
import { CompanyBucketHeader } from "@/components/contacts/CompanyBucketHeader";
import {
  extractDomain,
  isPersonalDomain,
  prettyCompanyName,
  contactLogoDomain,
  resolveCompanyDomain,
} from "@/lib/company-domains";
import { ContactDrawer } from "@/components/contacts/ContactDrawer";
import { AddContactsDialog } from "@/components/contacts/AddContactsDialog";
import { getContactAiToolsStatus } from "@/lib/contacts/ai-scan-status.functions";
import {
  ContactDetailView,
  type ContactEditorFlush,
} from "@/components/contacts/ContactDetailView";
import { listCompanyAliases, addCompanyAlias } from "@/lib/company-aliases.functions";
import { renameCompanyForContacts } from "@/lib/contacts/crud.functions";
import { normalizeCompanyName } from "@/lib/contacts/company-name";
import { listCompanyLogoChoices } from "@/lib/company-logo.functions";
import {
  listCompanies,
  openOrCreateCompanyForBucket,
  convergeBucketCompany,
  mergeCompanies,
  updateCompany,
} from "@/lib/companies/companies.functions";
import {
  buildInlineCompanyMergeSuggestions,
  type InlineCompanyMergeSuggestion,
} from "@/lib/companies/inline-merge";

export const Route = createFileRoute("/_authenticated/contacts/")({
  head: () => ({
    meta: [
      { title: "Contacts — Zerrow" },
      { name: "description", content: "People you've emailed with, enriched from signatures." },
    ],
  }),
  validateSearch: (search: Record<string, unknown>): { group?: string } =>
    typeof search.group === "string" && search.group ? { group: search.group } : {},
  component: ContactsPage,
  errorComponent: RouteErrorFallback,
});

/** First display letter for a contact's monogram avatar. */
function initialOf(c: { name?: string | null; email?: string | null }): string {
  return (c.name || c.email || "?").trim().charAt(0).toUpperCase() || "?";
}

/** Colored membership dots shown at the right edge of a contact row. */
function GroupDots({
  groupIds,
  groupsById,
}: {
  groupIds: string[];
  groupsById: Map<string, GroupRow>;
}) {
  if (groupIds.length === 0) return null;
  return (
    <div className="flex items-center gap-1">
      {groupIds.slice(0, 4).map((gid) => {
        const g = groupsById.get(gid);
        if (!g) return null;
        return (
          <span
            key={gid}
            className="h-2 w-2 rounded-full"
            style={{ background: g.color }}
            title={g.name}
          />
        );
      })}
    </div>
  );
}

function ScannedBadge() {
  return (
    <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] uppercase tracking-wide text-amber-400">
      scanned
    </span>
  );
}

/** Pill in the AI strip under the header — one per AI tool, showing a live
 * pending count and (for the enrichment scanner) a pulsing activity dot. */
function AiChip({
  label,
  onClick,
  highlight = false,
  pulsing = false,
}: {
  label: string;
  onClick: () => void;
  highlight?: boolean;
  pulsing?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-xs text-foreground transition-colors hover:border-amber-400/70 ${
        highlight ? "border-amber-400/35 bg-amber-500/10" : "border-border bg-transparent"
      }`}
    >
      {pulsing && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-green-400" />}
      {label}
    </button>
  );
}

/** True at ≥1280px — the split-view breakpoint where the contact detail pane
 * is docked on the right instead of opening as a slide-over drawer. */
function usePaneLayout() {
  const [isPane, setIsPane] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia("(min-width: 1280px)");
    const onChange = () => setIsPane(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return isPane;
}

function ContactsPage() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const list = useServerFn(listContacts);
  const listGroups = useServerFn(listContactGroups);
  const listAliases = useServerFn(listCompanyAliases);
  const listLogoChoices = useServerFn(listCompanyLogoChoices);
  const listCompaniesFn = useServerFn(listCompanies);
  const openCompanyFn = useServerFn(openOrCreateCompanyForBucket);
  const convergeCompanyFn = useServerFn(convergeBucketCompany);
  const mergeCompanyFn = useServerFn(mergeCompanies);
  const updateCompanyFn = useServerFn(updateCompany);
  const [openingBucketKey, setOpeningBucketKey] = useState<string | null>(null);

  const search = Route.useSearch();
  const [query, setQuery] = useState("");
  // Debounced copy drives the filtering/bucketing pipeline so a keystroke
  // doesn't recompute company buckets + merge suggestions on every character
  // (mirrors the inbox search's 250ms debounce).
  const [debouncedQuery, setDebouncedQuery] = useState("");
  useEffect(() => {
    const h = setTimeout(() => setDebouncedQuery(query), 250);
    return () => clearTimeout(h);
  }, [query]);
  const [filter, setFilter] = useState<"all" | "ungrouped" | string>(search.group ?? "all");

  // Deep link from the Labels page ("View contacts"): follow ?group= changes.
  useEffect(() => {
    if (search.group) setFilter(search.group);
  }, [search.group]);

  // Selecting a group writes it back to the URL so back/forward and shared
  // links restore the filter (the deep-link effect above is the read side).
  function selectFilter(id: "all" | "ungrouped" | string) {
    setFilter(id);
    nav({
      to: "/contacts",
      search: id === "all" ? {} : { group: id },
      replace: true,
    });
  }
  const [groupDialog, setGroupDialog] = useState<
    null | { mode: "create" } | { mode: "edit"; group: GroupRow }
  >(null);
  const [addOpen, setAddOpen] = useState(false);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [mobileAiOpen, setMobileAiOpen] = useState(false);
  const [groupByCompany, setGroupByCompany] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [dupesOpen, setDupesOpen] = useState(false);
  const [enrichOpen, setEnrichOpen] = useState(false);
  const [labelDupesOpen, setLabelDupesOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [mergeOpen, setMergeOpen] = useState(false);
  const bulkAddToGroups = useServerFn(addContactsToGroups);
  const backfillAutoGroups = useServerFn(reconcileAllAutoGroups);

  // Split view: on wide screens the selected contact renders in a docked
  // right-hand pane; below the breakpoint rows keep opening the drawer.
  const isPane = usePaneLayout();
  const [paneId, setPaneId] = useState<string | null>(null);
  const [paneDirty, setPaneDirty] = useState(false);
  const paneFlushRef = useRef<ContactEditorFlush | null>(null);
  const handlePaneDirtyChange = useCallback((d: boolean) => setPaneDirty(d), []);

  // Dominant logo color per company bucket (reported by CompanyBucketHeader)
  // so rows can tint their monogram avatars to match the section.
  const [bucketColors, setBucketColors] = useState<Map<string, string>>(new Map());
  const reportBucketColor = useCallback((key: string, color: string) => {
    setBucketColors((prev) => {
      if (prev.get(key) === color) return prev;
      const next = new Map(prev);
      next.set(key, color);
      return next;
    });
  }, []);

  // Live counts for the AI strip chips (group suggestions / duplicates /
  // enrichment). Cheap head-count queries; drawers keep it current.
  const aiToolsStatusFn = useServerFn(getContactAiToolsStatus);
  const aiStatusQ = useQuery({
    queryKey: ["contact-ai-tools-status"],
    queryFn: () => aiToolsStatusFn(),
    staleTime: 15_000,
  });

  // Once per browser tab session: reconcile every auto-company-subgroup parent
  // so groups pick up contacts added since the last reconcile (Google sync,
  // manual create, company edits elsewhere). sessionStorage means it re-runs
  // on each fresh tab load without hammering on every route change.
  useEffect(() => {
    const KEY = "zerrow.auto-groups.backfilled.session";
    if (typeof window === "undefined") return;
    if (window.sessionStorage.getItem(KEY)) return;

    let cancelled = false;
    (async () => {
      try {
        const res = await backfillAutoGroups({});
        if (cancelled) return;
        window.sessionStorage.setItem(KEY, "1");
        if (res.membershipsAdded > 0 || res.membershipsRemoved > 0) {
          qc.invalidateQueries({ queryKey: ["contacts"] });
          qc.invalidateQueries({ queryKey: ["contact-groups"] });
        }
      } catch {
        // Best-effort; will retry on next mount if it failed.
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // These payloads are large (contacts alone can be up to 2,000 rows); keep
  // them fresh for a couple of minutes so remounts/refocus reuse the cache
  // instead of re-downloading. Mutations invalidate explicitly.
  const LIST_STALE_MS = 2 * 60_000;
  const q = useQuery({ queryKey: ["contacts"], queryFn: () => list(), staleTime: LIST_STALE_MS });
  const gq = useQuery({
    queryKey: ["contact-groups"],
    queryFn: () => listGroups(),
    staleTime: LIST_STALE_MS,
  });
  const aq = useQuery({
    queryKey: ["company-aliases"],
    queryFn: () => listAliases(),
    staleTime: LIST_STALE_MS,
  });
  const lq = useQuery({
    queryKey: ["company-logo-choices"],
    queryFn: () => listLogoChoices(),
    staleTime: LIST_STALE_MS,
  });
  const cq = useQuery({
    queryKey: ["companies"],
    queryFn: () => listCompaniesFn(),
    staleTime: LIST_STALE_MS,
  });

  // company_id -> preferred logo domain (first company_domain, auto or manual).
  const companyDomainById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of cq.data?.companies ?? []) {
      const primary = c.domains?.[0]?.domain;
      if (primary) m.set(c.id, primary);
    }
    return m;
  }, [cq.data]);

  const logoProviderByDomain = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of lq.data ?? []) {
      m.set(r.domain, r.provider);
      if (r.source_domain) m.set(r.source_domain, r.provider);
    }
    return m;
  }, [lq.data]);

  const logoSourceByDomain = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of lq.data ?? []) {
      if (r.source_domain) {
        m.set(r.domain, r.source_domain);
        m.set(r.source_domain, r.source_domain);
      }
    }
    return m;
  }, [lq.data]);

  // contact_id -> [group ids]
  const contactGroupMap = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const x of gq.data?.memberships ?? []) {
      const arr = m.get(x.contact_id) ?? [];
      arr.push(x.group_id);
      m.set(x.contact_id, arr);
    }
    return m;
  }, [gq.data]);

  const groupsById = useMemo(() => {
    const m = new Map<string, GroupRow>();
    for (const g of gq.data?.groups ?? []) m.set(g.id, g);
    return m;
  }, [gq.data]);

  // Tree pre-order + per-group depth for indented sidebar rendering.
  const groupTree = useMemo(() => buildGroupTree(gq.data?.groups ?? []), [gq.data]);

  // groupId -> Set of descendant group ids (including itself) for filtering.
  const descendantsById = useMemo(() => buildDescendantsById(gq.data?.groups ?? []), [gq.data]);

  const filtered = useMemo(() => {
    const all = q.data?.contacts ?? [];
    const t = debouncedQuery.toLowerCase().trim();
    const allowedGroupIds =
      filter !== "all" && filter !== "ungrouped"
        ? (descendantsById.get(filter) ?? new Set([filter]))
        : null;
    return all.filter((x) => {
      if (filter === "ungrouped" && (contactGroupMap.get(x.id)?.length ?? 0) > 0) return false;
      if (allowedGroupIds) {
        const gids = contactGroupMap.get(x.id) ?? [];
        if (!gids.some((gid) => allowedGroupIds.has(gid))) return false;
      }
      if (!t) return true;
      return (
        (x.name ?? "").toLowerCase().includes(t) ||
        (x.email ?? "").toLowerCase().includes(t) ||
        (x.company ?? "").toLowerCase().includes(t)
      );
    });
  }, [q.data, debouncedQuery, filter, contactGroupMap, descendantsById]);

  const ungroupedCount = useMemo(() => {
    const all = q.data?.contacts ?? [];
    let n = 0;
    for (const c of all) if ((contactGroupMap.get(c.id)?.length ?? 0) === 0) n++;
    return n;
  }, [q.data, contactGroupMap]);

  // Incremental list rendering: mounting the whole address book (up to 2,000
  // rows / hundreds of company sections) at once makes the page sluggish.
  // Render a window and grow it when the sentinel at the bottom becomes
  // visible; the window resets whenever the visible set changes.
  const INITIAL_VISIBLE = 120;
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE);
  useEffect(() => {
    setVisibleCount(INITIAL_VISIBLE);
  }, [debouncedQuery, filter, groupByCompany]);
  // Callback ref: attaches the observer exactly once per sentinel element
  // (the sentinel mounts/unmounts as the window grows). The previous effect
  // had no dependency array and rebuilt the observer on every render.
  const sentinelObserverRef = useRef<IntersectionObserver | null>(null);
  const listSentinelRef = (el: HTMLDivElement | null) => {
    sentinelObserverRef.current?.disconnect();
    sentinelObserverRef.current = null;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setVisibleCount((n) => n + INITIAL_VISIBLE);
      }
    });
    io.observe(el);
    sentinelObserverRef.current = io;
  };

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleBucketSelection(ids: string[]) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const allSelected = ids.length > 0 && ids.every((id) => next.has(id));
      if (allSelected) ids.forEach((id) => next.delete(id));
      else ids.forEach((id) => next.add(id));
      return next;
    });
  }
  /** Open a contact: docked pane on wide screens (flushing any half-saved
   * edit in the pane first), slide-over drawer below the breakpoint. */
  function handleRowClick(id: string) {
    if (!isPane) {
      setDrawerId(id);
      return;
    }
    if (id === paneId) return;
    const flush = paneFlushRef.current;
    if (paneDirty && flush) {
      void flush().then((result) => {
        if (result === "invalid") {
          toast.error("Finish the incomplete email or phone entry first, or clear it.");
          return;
        }
        if (result === "error") {
          toast.error("Couldn't save your latest edits — they may not have been stored.");
        }
        setPaneId(id);
      });
      return;
    }
    setPaneId(id);
  }
  function selectAllVisible() {
    setSelectedIds(new Set(filtered.map((c) => c.id)));
  }
  function clearSelection() {
    setSelectedIds(new Set());
  }
  async function bulkAssignGroups(groupIds: string[]) {
    if (!groupIds.length || selectedIds.size === 0) return;
    try {
      await bulkAddToGroups({
        data: { groupIds, contactIds: Array.from(selectedIds) },
      });
      toast.success(`Added ${selectedIds.size} contact${selectedIds.size === 1 ? "" : "s"}`);
      qc.invalidateQueries({ queryKey: ["contact-groups"] });
      clearSelection();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed");
    }
  }

  // Keep the docked pane populated: pick the first visible contact when
  // nothing is selected (or the selected contact was deleted/merged away).
  useEffect(() => {
    if (!isPane) return;
    const all = q.data?.contacts;
    if (!all) return;
    if (paneId && all.some((c) => c.id === paneId)) return;
    const first = filtered[0] ?? all[0];
    setPaneId(first ? first.id : null);
  }, [isPane, paneId, q.data, filtered]);
  type Contact = (typeof filtered)[number];
  type Bucket = {
    key: string;
    domain: string | null;
    name: string;
    kind: "company" | "personal" | "other";
    contacts: Contact[];
    /** Resolved Company entity id, when the bucket is a linked company. */
    companyId?: string;
    /** Custom uploaded company logo URL, when set. */
    companyLogoUrl?: string | null;
  };

  const aliasMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of aq.data ?? []) m.set(r.alias_domain, r.primary_domain);
    return m;
  }, [aq.data]);

  const aliasesByPrimary = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const r of aq.data ?? []) {
      const arr = m.get(r.primary_domain) ?? [];
      arr.push(r.alias_domain);
      m.set(r.primary_domain, arr);
    }
    return m;
  }, [aq.data]);

  // Company-entity lookups so bucketing can group by the LINKED company
  // first: a contact tied to a Company row belongs in that company's bucket
  // even when their email domain is missing/personal (fixes "two Zimmerman
  // Advertising rows" when one member has no work email).
  const companyById = useMemo(() => {
    const m = new Map<string, { name: string; domain: string | null; logoUrl: string | null }>();
    for (const c of cq.data?.companies ?? []) {
      m.set(c.id, {
        name: c.name,
        domain: c.domains?.[0]?.domain ?? null,
        logoUrl: (c as { logo_url?: string | null }).logo_url ?? null,
      });
    }
    return m;
  }, [cq.data]);
  const companyIdByDomain = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of cq.data?.companies ?? []) {
      for (const d of c.domains ?? []) {
        if (d.domain) m.set(d.domain.toLowerCase(), c.id);
      }
    }
    return m;
  }, [cq.data]);

  const companyBuckets = useMemo<Bucket[]>(() => {
    const map = new Map<string, Bucket>();
    const PERSONAL_KEY = "__personal__";
    const OTHER_KEY = "__other__";
    for (const c of filtered) {
      const rawDomain = extractDomain(c.email);
      const d = resolveCompanyDomain(rawDomain, aliasMap);
      const webDomain = contactLogoDomain(c.website, c.email);
      const resolvedWeb = resolveCompanyDomain(webDomain, aliasMap);
      let key: string;
      let bucket: Bucket | undefined;
      const manualCompany = (c.company ?? "").trim();
      // Linked company wins; contacts whose email domain belongs to a known
      // company collapse into the same bucket even without an explicit link.
      // Personal domains never participate in the domain lookup or in seeding
      // the bucket's display domain — a gmail-only member of a domainless
      // company must not turn the bucket into a "gmail.com company".
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
        key = `name:${normalizeCompanyName(manualCompany)}`;
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
    // with an existing domain bucket (e.g. contacts with no email but a
    // website pointing to nucar.com should merge into the nucar.com bucket).
    // Name-keyed buckets with no derivable domain at all fold into a company
    // bucket with the same normalized name instead — a contact with only
    // "Zimmerman Advertising" typed in must not mint a second company row.
    const byDomain = new Map<string, Bucket>();
    const byNormName = new Map<string, Bucket>();
    for (const b of arr) {
      if (b.kind === "company" && !b.key.startsWith("name:")) {
        if (b.domain) byDomain.set(b.domain, b);
        const norm = normalizeCompanyName(b.name);
        if (norm && !byNormName.has(norm)) byNormName.set(norm, b);
      }
    }
    const collapsed: Bucket[] = [];
    for (const b of arr) {
      if (b.kind === "company" && b.key.startsWith("name:")) {
        if (b.domain && byDomain.has(b.domain)) {
          byDomain.get(b.domain)!.contacts.push(...b.contacts);
          continue;
        }
        // Name fold only when the bucket has NO domain evidence at all — a
        // derived domain that matches nothing means these contacts belong to
        // a DIFFERENT company that merely shares a brand token ("Apex Group"
        // at apexgroup.com must not fold into "Apex" at apex.com).
        if (!b.domain) {
          const norm = normalizeCompanyName(b.name);
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
  }, [filtered, aliasMap, companyById, companyIdByDomain]);

  // Same-name merge suggestions: buckets that share a normalized company name
  // but live on different domains. Persisted dismissals live in localStorage.
  const addAlias = useServerFn(addCompanyAlias);
  const [mergeDismissed, setMergeDismissed] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set();
    try {
      const raw = window.localStorage.getItem("zerrow.mergeDismissed");
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set();
    }
  });
  const [mergingKey, setMergingKey] = useState<string | null>(null);

  const mergeSuggestions = useMemo(
    () => buildInlineCompanyMergeSuggestions(companyBuckets, mergeDismissed),
    [companyBuckets, mergeDismissed],
  );

  function dismissMerge(normalizedName: string) {
    setMergeDismissed((prev) => {
      const next = new Set(prev);
      next.add(normalizedName);
      if (typeof window !== "undefined") {
        try {
          window.localStorage.setItem("zerrow.mergeDismissed", JSON.stringify(Array.from(next)));
        } catch {
          // ignore quota errors
        }
      }
      return next;
    });
  }

  const renameCompanyFn = useServerFn(renameCompanyForContacts);
  async function performMerge(s: InlineCompanyMergeSuggestion) {
    setMergingKey(s.normalizedName);
    try {
      if (s.kind === "company") {
        if (!s.primaryCompanyId) throw new Error("Target company not found");
        await updateCompanyFn({ data: { id: s.primaryCompanyId, name: s.displayName } });
        for (const sourceId of s.sourceCompanyIds) {
          await mergeCompanyFn({ data: { sourceId, targetId: s.primaryCompanyId } });
        }
      } else {
        // Guard: always skip an alias equal to primary as a belt-and-suspenders check.
        const cleanAliases = s.aliasDomains.filter((d) => d !== s.primaryDomain);
        for (const alias of cleanAliases) {
          await addAlias({ data: { primaryDomain: s.primaryDomain, aliasDomain: alias } });
        }
        if (s.kind === "rename" && s.aliasContactIds.length > 0) {
          // Same domain, different name variants — normalize the company name
          // on the non-primary contacts so the buckets collapse on next render.
          await renameCompanyFn({
            data: { contactIds: s.aliasContactIds, newName: s.displayName },
          });
        }
      }
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["company-aliases"] }),
        qc.invalidateQueries({ queryKey: ["companies"] }),
        qc.invalidateQueries({ queryKey: ["contacts"] }),
        qc.invalidateQueries({ queryKey: ["contact-groups"] }),
        qc.invalidateQueries({ queryKey: ["companies", "duplicates"] }),
      ]);
      toast.success(`Merged ${s.otherCount + 1} companies into "${s.displayName}".`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Merge failed");
    } finally {
      setMergingKey(null);
    }
  }

  // Open a company group's page. Linked-company buckets navigate straight to
  // the detail page; name/domain-only groups first materialize a real Company
  // (and link their contacts to it) so there's a page to open.
  async function openBucketCompany(b: Bucket) {
    if (b.companyId) {
      nav({ to: "/contacts/companies/$companyId", params: { companyId: b.companyId } });
      return;
    }
    setOpeningBucketKey(b.key);
    const contactIds = b.contacts.map((c) => c.id);
    try {
      // Fast path: create the company + link contacts, then navigate right
      // away. The heavy convergence (domain discovery, label-rule sync,
      // subgroup reconcile) runs in the background so the arrow doesn't spin.
      const { companyId } = await openCompanyFn({
        data: { name: b.name, domain: b.domain, contactIds },
      });
      nav({ to: "/contacts/companies/$companyId", params: { companyId } });
      void convergeCompanyFn({ data: { companyId, contactIds } })
        .then(() => {
          qc.invalidateQueries({ queryKey: ["companies"] });
          qc.invalidateQueries({ queryKey: ["contacts"] });
        })
        .catch(() => {
          // Best-effort — domains/labels also converge via other triggers and
          // the company page's "Discover from members" button.
        });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not open company");
    } finally {
      setOpeningBucketKey(null);
    }
  }

  function toggleBucket(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  // True when every visible company bucket is collapsed — drives the
  // Expand-all / Collapse-all toolbar toggle.
  const allBucketsCollapsed =
    companyBuckets.length > 0 && companyBuckets.every((b) => collapsed.has(b.key));
  function toggleAllBuckets() {
    if (allBucketsCollapsed) setCollapsed(new Set());
    else setCollapsed(new Set(companyBuckets.map((b) => b.key)));
  }
  // Auto-collapse all buckets when toggling "By company" on, and again the
  // first time buckets become available (initial load races contacts query).
  const initialCollapseDoneRef = useRef(false);
  useEffect(() => {
    if (groupByCompany) {
      setCollapsed(new Set(companyBuckets.map((b) => b.key)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupByCompany]);
  useEffect(() => {
    // Wait for the companies query to settle before latching: bucket keys
    // flip from domain keys to cid:<id> once cq lands, and collapsing the
    // pre-cq keys would leave every linked-company bucket expanded.
    const companiesSettled = !!cq.data || cq.isError;
    if (
      !initialCollapseDoneRef.current &&
      groupByCompany &&
      companyBuckets.length > 0 &&
      companiesSettled
    ) {
      initialCollapseDoneRef.current = true;
      setCollapsed(new Set(companyBuckets.map((b) => b.key)));
    }
  }, [companyBuckets, groupByCompany, cq.data, cq.isError]);

  const groupSuggestionCount = aiStatusQ.data?.groups.pendingCount ?? 0;
  const duplicateCount = aiStatusQ.data?.duplicates.pendingCount ?? 0;
  const enrichPending = aiStatusQ.data?.enrichment.pendingCount ?? 0;
  const enrichScanning = aiStatusQ.data?.enrichment.scanActive ?? false;
  const companiesCount = companyBuckets.filter((b) => b.kind === "company").length;

  return (
    <>
      <div className="relative flex h-full min-h-0 overflow-hidden">
        {/* Groups rail (desktop) — the split view's far-left column. */}
        <aside className="hidden w-56 shrink-0 flex-col border-r border-border bg-card/30 md:flex">
          <div className="flex items-center justify-between px-4 pb-1 pt-4">
            <span className="text-[11px] uppercase tracking-widest text-muted-foreground">
              Groups
            </span>
            <div className="flex items-center gap-1">
              <Link
                to="/contacts/labels"
                className="grid h-5 w-5 place-items-center rounded text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                title="Manage labels"
              >
                <Settings2 className="h-3.5 w-3.5" />
              </Link>
              <button
                onClick={() => setGroupDialog({ mode: "create" })}
                className="grid h-5 w-5 place-items-center rounded text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                title="New group"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-4 pt-1">
            <GroupChip
              active={filter === "all"}
              color="#a3a3a3"
              label="All contacts"
              count={q.data?.contacts.length ?? 0}
              onClick={() => selectFilter("all")}
            />
            <GroupChip
              active={filter === "ungrouped"}
              color="#71717a"
              label="Ungrouped"
              count={ungroupedCount}
              onClick={() => selectFilter("ungrouped")}
            />
            {groupTree.map(({ group: g, depth }) => {
              const isAuto = !!g.auto_generated_from_group_id;
              return (
                <div key={g.id} style={{ paddingLeft: depth * 12 }}>
                  <GroupChip
                    active={filter === g.id}
                    color={g.color}
                    label={g.name}
                    count={g.count}
                    onClick={() => selectFilter(g.id)}
                    onEdit={isAuto ? undefined : () => setGroupDialog({ mode: "edit", group: g })}
                    locked={isAuto}
                    ai={g.kind === "ai_category"}
                  />
                </div>
              );
            })}
            {groupTree.length === 0 && (
              <p className="px-3 py-3 text-xs text-muted-foreground">
                No groups yet. Click + to add one like “Work” or “Personal”.
              </p>
            )}
          </div>
        </aside>

        {/* Main column: header bar, AI strip, then list + docked detail pane. */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-card/40 px-4 py-3 sm:px-5">
            <div className="min-w-0">
              <h1 className="font-display text-xl leading-6 text-foreground">Contacts</h1>
              <p className="text-[11px] text-muted-foreground">
                {q.data
                  ? `${q.data.contacts.length} people${
                      groupByCompany && companiesCount > 0 ? ` · ${companiesCount} companies` : ""
                    }`
                  : "Loading…"}
              </p>
            </div>
            <div className="relative hidden min-w-[160px] max-w-[480px] flex-1 sm:block">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search people, companies, titles…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="h-9 pl-9"
              />
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Button
                variant={groupByCompany ? "default" : "outline"}
                size="sm"
                onClick={() => setGroupByCompany((v) => !v)}
                title={groupByCompany ? "Switch to flat contact list" : "Group by company"}
                aria-pressed={groupByCompany}
                className="h-8 w-8 p-0"
              >
                <Building2 className="h-4 w-4" />
              </Button>
              {groupByCompany && companyBuckets.length > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={toggleAllBuckets}
                  title={allBucketsCollapsed ? "Expand all companies" : "Collapse all companies"}
                  aria-label={
                    allBucketsCollapsed ? "Expand all companies" : "Collapse all companies"
                  }
                  className="h-8 w-8 p-0"
                >
                  {allBucketsCollapsed ? (
                    <ChevronsUpDown className="h-4 w-4" />
                  ) : (
                    <ChevronsDownUp className="h-4 w-4" />
                  )}
                </Button>
              )}
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              <Button
                variant={mobileSearchOpen ? "default" : "outline"}
                size="sm"
                onClick={() => {
                  setMobileSearchOpen((v) => !v);
                  setMobileAiOpen(false);
                }}
                className="h-8 w-8 p-0 sm:hidden"
                aria-label="Search contacts"
                aria-pressed={mobileSearchOpen}
                title="Search"
              >
                <Search className="h-4 w-4" />
              </Button>
              <Button
                variant={mobileAiOpen ? "default" : "outline"}
                size="sm"
                onClick={() => {
                  setMobileAiOpen((v) => !v);
                  setMobileSearchOpen(false);
                }}
                className="h-8 w-8 p-0 sm:hidden"
                aria-label="AI suggestions"
                aria-pressed={mobileAiOpen}
                title="AI suggestions"
              >
                <Sparkles className="h-4 w-4" />
              </Button>
              <Button variant="outline" size="sm" asChild className="h-8 w-8 p-0">
                <Link to="/my-card" aria-label="My card" title="My card">
                  <IdCard className="h-4 w-4" />
                </Link>
              </Button>
              <Button variant="outline" size="sm" asChild className="h-8 w-8 p-0">
                <Link to="/contacts/scan" aria-label="Scan card" title="Scan card">
                  <ScanLine className="h-4 w-4" />
                </Link>
              </Button>
              <Button
                size="sm"
                onClick={() => setAddOpen(true)}
                className="h-8 px-2 sm:px-3"
                aria-label="Add contact"
                title="Add contact"
              >
                <Plus className="h-4 w-4 sm:mr-1.5" />
                <span className="hidden sm:inline">Add contact</span>
              </Button>
            </div>
          </div>

          {/* Mobile expanded search row */}
          {mobileSearchOpen && (
            <div className="flex shrink-0 items-center gap-2 border-b border-border bg-card/40 px-4 py-2 sm:hidden">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  autoFocus
                  placeholder="Search people, companies, titles…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="h-9 pl-9"
                />
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setQuery("");
                  setMobileSearchOpen(false);
                }}
                className="h-8 w-8 shrink-0 p-0"
                aria-label="Close search"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          )}

          {/* AI strip — live entry points for the AI tools. Hidden on mobile unless toggled. */}
          <div
            className={`${mobileAiOpen ? "flex" : "hidden"} shrink-0 items-center gap-2 overflow-x-auto border-b border-border bg-amber-500/5 px-4 py-2 sm:flex sm:px-5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden`}
          >
            <Sparkles className="h-3.5 w-3.5 shrink-0 text-amber-400" />
            <AiChip
              label={`${groupSuggestionCount} group suggestion${groupSuggestionCount === 1 ? "" : "s"}`}
              onClick={() => setSuggestOpen(true)}
              highlight={groupSuggestionCount > 0}
            />
            <AiChip
              label={`${duplicateCount} duplicate${duplicateCount === 1 ? "" : "s"} & merges`}
              onClick={() => setDupesOpen(true)}
              highlight={duplicateCount > 0}
            />
            <AiChip label="Label duplicates" onClick={() => setLabelDupesOpen(true)} />
            <AiChip
              label={
                enrichScanning
                  ? "Enriching from inbox…"
                  : `${enrichPending} enrichment suggestion${enrichPending === 1 ? "" : "s"}`
              }
              onClick={() => setEnrichOpen(true)}
              highlight={enrichPending > 0}
              pulsing={enrichScanning}
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setMobileAiOpen(false)}
              className="ml-auto h-7 w-7 shrink-0 p-0 sm:hidden"
              aria-label="Close AI suggestions"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          {/* Mobile groups: horizontal pill scroller */}
          <div className="shrink-0 px-4 pt-3 md:hidden max-w-full overflow-hidden">
            <div className="flex flex-nowrap gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <GroupPill
                active={filter === "all"}
                color="#a3a3a3"
                label="All"
                count={q.data?.contacts.length ?? 0}
                onClick={() => selectFilter("all")}
              />
              <GroupPill
                active={filter === "ungrouped"}
                color="#71717a"
                label="Ungrouped"
                count={ungroupedCount}
                onClick={() => selectFilter("ungrouped")}
              />
              {groupTree.map(({ group: g, depth }) => {
                const isAuto = !!g.auto_generated_from_group_id;
                return (
                  <GroupPill
                    key={g.id}
                    active={filter === g.id}
                    color={g.color}
                    label={depth > 0 ? `${"— ".repeat(depth)}${g.name}` : g.name}
                    count={g.count}
                    onClick={() => selectFilter(g.id)}
                    onEdit={isAuto ? undefined : () => setGroupDialog({ mode: "edit", group: g })}
                    locked={isAuto}
                  />
                );
              })}
              <button
                onClick={() => setGroupDialog({ mode: "create" })}
                className="inline-flex shrink-0 items-center gap-1 rounded-full border border-dashed border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent/40 hover:text-foreground"
              >
                <Plus className="h-3.5 w-3.5" /> New
              </button>
              <Link
                to="/contacts/labels"
                className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent/40 hover:text-foreground"
              >
                <Settings2 className="h-3.5 w-3.5" /> Manage
              </Link>
            </div>
          </div>

          {/* List + docked detail pane */}
          <div className="flex min-h-0 flex-1">
            <div className="min-w-0 flex-1 overflow-y-auto">
              {q.isLoading ? (
                <div className="grid gap-2 p-4">
                  {Array.from({ length: 8 }).map((_, i) => (
                    <div
                      key={i}
                      className="h-14 animate-pulse rounded-md border border-border bg-card/40"
                    />
                  ))}
                </div>
              ) : q.isError ? (
                <div className="py-12 text-center">
                  <p className="text-sm text-muted-foreground">Couldn't load contacts.</p>
                  <Button variant="outline" size="sm" className="mt-3" onClick={() => q.refetch()}>
                    Retry
                  </Button>
                </div>
              ) : filtered.length === 0 ? (
                <p className="py-12 text-center text-sm text-muted-foreground">
                  {query ? "No matches." : "No contacts yet. Scan a card or add one manually."}
                </p>
              ) : groupByCompany ? (
                <div className="pb-20">
                  {companyBuckets.slice(0, visibleCount).map((b) => {
                    const isCollapsed = collapsed.has(b.key);
                    return (
                      <section key={b.key}>
                        <CompanyBucketHeader
                          domain={b.domain}
                          name={b.name}
                          count={b.contacts.length}
                          collapsed={isCollapsed}
                          onToggle={() => toggleBucket(b.key)}
                          onColor={(color) => reportBucketColor(b.key, color)}
                          aliasCount={
                            b.kind === "company" && b.domain
                              ? (aliasesByPrimary.get(b.domain)?.length ?? 0)
                              : 0
                          }
                          logoProvider={
                            b.kind === "company" && b.domain
                              ? (logoProviderByDomain.get(b.domain) ?? null)
                              : null
                          }
                          logoSourceDomain={
                            b.kind === "company" && b.domain
                              ? (logoSourceByDomain.get(b.domain) ?? null)
                              : null
                          }
                          photoUrl={b.companyLogoUrl ?? null}
                          onOpen={b.kind === "company" ? () => openBucketCompany(b) : undefined}
                          opening={openingBucketKey === b.key}
                          selectable={selectedIds.size > 0}
                          selectionState={(() => {
                            const ids = b.contacts.map((c) => c.id);
                            const sel = ids.filter((id) => selectedIds.has(id)).length;
                            if (sel === 0) return "none";
                            if (sel === ids.length) return "all";
                            return "some";
                          })()}
                          onToggleSelectAll={() =>
                            toggleBucketSelection(b.contacts.map((c) => c.id))
                          }
                        />

                        {(() => {
                          const s = mergeSuggestions.get(b.key);
                          if (!s) return null;
                          const isPrimary = s.primaryBucketKey === b.key;
                          return (
                            <div className="flex flex-wrap items-center gap-2 border-b border-border/50 bg-amber-500/10 px-4 py-2 text-xs text-foreground">
                              <Sparkles className="h-3.5 w-3.5 text-amber-600" />
                              <span className="flex-1 min-w-0">
                                {s.otherCount + 1} companies share the name{" "}
                                <strong>&ldquo;{s.displayName}&rdquo;</strong>
                                {s.kind === "alias" ? " on different domains." : "."}{" "}
                                {isPrimary
                                  ? `Merge the other ${s.otherCount} into this one?`
                                  : s.kind === "alias"
                                    ? `Merge into ${s.primaryDomain}?`
                                    : `Merge into "${s.displayName}"?`}
                              </span>
                              <Button
                                size="sm"
                                variant="default"
                                className="h-7"
                                disabled={mergingKey === s.normalizedName}
                                onClick={() => performMerge(s)}
                              >
                                {mergingKey === s.normalizedName ? "Merging…" : "Merge"}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7"
                                onClick={() => dismissMerge(s.normalizedName)}
                              >
                                Dismiss
                              </Button>
                            </div>
                          );
                        })()}

                        {!isCollapsed && (
                          <ul className="divide-y divide-border/50">
                            {b.contacts.map((c) => {
                              const gids = contactGroupMap.get(c.id) ?? [];
                              const isActive = isPane && paneId === c.id;
                              const isChecked = selectedIds.has(c.id);
                              const tint = bucketColors.get(b.key) ?? null;
                              return (
                                <li key={c.id}>
                                  <div
                                    role="button"
                                    tabIndex={0}
                                    onClick={() => handleRowClick(c.id)}
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter" || e.key === " ") {
                                        e.preventDefault();
                                        handleRowClick(c.id);
                                      }
                                    }}
                                    className={`flex w-full cursor-pointer items-center gap-3 border-l-2 px-4 py-3 text-left transition-colors hover:bg-accent/40 sm:gap-2.5 sm:py-2 ${
                                      isActive
                                        ? "border-l-primary bg-primary/[0.07]"
                                        : isChecked
                                          ? "border-l-transparent bg-accent/50"
                                          : "border-l-transparent"
                                    }`}
                                  >
                                    <Checkbox
                                      className="h-3.5 w-3.5"
                                      checked={isChecked}
                                      onCheckedChange={() => toggleSelect(c.id)}
                                      onClick={(e) => e.stopPropagation()}
                                      aria-label={`Select ${c.name || c.email || "contact"}`}
                                    />
                                    <div
                                      className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-[11px] font-semibold ${
                                        tint ? "" : "bg-primary/15 text-primary"
                                      }`}
                                      style={
                                        tint
                                          ? {
                                              background: `color-mix(in oklab, ${tint} 22%, transparent)`,
                                              color: tint,
                                            }
                                          : undefined
                                      }
                                    >
                                      {initialOf(c)}
                                    </div>
                                    <div className="flex min-w-0 flex-1 items-baseline gap-2">
                                      <span className="truncate text-sm font-medium text-foreground">
                                        {c.name || c.email}
                                      </span>
                                      <span className="min-w-0 truncate text-xs text-muted-foreground">
                                        {b.kind === "company" ? c.title || c.email : c.email}
                                      </span>
                                    </div>
                                    <GroupDots groupIds={gids} groupsById={groupsById} />
                                    {c.source === "scan" && <ScannedBadge />}
                                  </div>
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </section>
                    );
                  })}
                  {companyBuckets.length > visibleCount && (
                    <div ref={listSentinelRef} className="py-3 text-center">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setVisibleCount((n) => n + INITIAL_VISIBLE)}
                      >
                        Show more ({companyBuckets.length - visibleCount} more companies)
                      </Button>
                    </div>
                  )}
                </div>
              ) : (
                <ul className="divide-y divide-border/50 pb-20">
                  {filtered.slice(0, visibleCount).map((c) => {
                    const gids = contactGroupMap.get(c.id) ?? [];
                    // Prefer the linked company's primary domain. This ensures
                    // Aditya @ Nissan uses Nissan's logo, and personal-email
                    // contacts don't accidentally borrow another company's icon.
                    const companyDom = c.company_id
                      ? (companyDomainById.get(c.company_id) ?? null)
                      : null;
                    const fallbackDom = contactLogoDomain(c.website, c.email);
                    const dom = companyDom ?? fallbackDom;
                    const resolvedDom = resolveCompanyDomain(dom, aliasMap);
                    const logoProv = resolvedDom
                      ? (logoProviderByDomain.get(resolvedDom) ?? null)
                      : null;
                    const logoSrc = resolvedDom
                      ? (logoSourceByDomain.get(resolvedDom) ?? null)
                      : null;
                    const showLogo = !!dom;
                    // Personal initial when no company link — never a company's
                    // initial (which produced the stray "N" for Nissan before).
                    const personInitial = initialOf(c);
                    const isActive = isPane && paneId === c.id;
                    const isChecked = selectedIds.has(c.id);
                    return (
                      <li key={c.id}>
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() => handleRowClick(c.id)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              handleRowClick(c.id);
                            }
                          }}
                          className={`flex w-full cursor-pointer items-center gap-3 border-l-2 px-4 py-3 text-left transition-colors hover:bg-accent/40 sm:gap-2.5 sm:py-2.5 ${
                            isActive
                              ? "border-l-primary bg-primary/[0.07]"
                              : isChecked
                                ? "border-l-transparent bg-accent/50"
                                : "border-l-transparent"
                          }`}
                        >
                          <Checkbox
                            className="h-3.5 w-3.5"
                            checked={isChecked}
                            onCheckedChange={() => toggleSelect(c.id)}
                            onClick={(e) => e.stopPropagation()}
                            aria-label={`Select ${c.name || c.email || "contact"}`}
                          />
                          {showLogo ? (
                            <CompanyLogo
                              domain={resolvedDom ?? dom}
                              name={personInitial}
                              size={32}
                              className="rounded-full"
                              provider={logoProv}
                              sourceDomain={logoSrc}
                            />
                          ) : (
                            <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
                              {personInitial}
                            </div>
                          )}
                          <div className="flex min-w-0 flex-1 items-baseline gap-2">
                            <span className="truncate text-sm font-medium text-foreground">
                              {c.name || c.email}
                            </span>
                            <span className="min-w-0 truncate text-xs text-muted-foreground">
                              {c.company ? `${c.company} · ` : ""}
                              {c.email}
                            </span>
                          </div>
                          <GroupDots groupIds={gids} groupsById={groupsById} />
                          {c.source === "scan" && <ScannedBadge />}
                        </div>
                      </li>
                    );
                  })}
                  {filtered.length > visibleCount && (
                    <li>
                      <div ref={listSentinelRef} className="py-3 text-center">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setVisibleCount((n) => n + INITIAL_VISIBLE)}
                        >
                          Show more ({filtered.length - visibleCount} more contacts)
                        </Button>
                      </div>
                    </li>
                  )}
                </ul>
              )}
            </div>

            {/* Docked contact detail pane (≥xl). Below the breakpoint rows
                open the slide-over ContactDrawer instead. */}
            <aside className="hidden w-[clamp(300px,30vw,400px)] shrink-0 flex-col border-l border-border bg-card/30 xl:flex">
              <div className="min-h-0 flex-1 overflow-y-auto p-5">
                {paneId ? (
                  <ContactDetailView
                    key={paneId}
                    id={paneId}
                    onDeleted={() => {
                      setPaneId(null);
                      qc.invalidateQueries({ queryKey: ["contacts"] });
                    }}
                    onDirtyChange={handlePaneDirtyChange}
                    flushRef={paneFlushRef}
                  />
                ) : (
                  <div className="grid h-full place-items-center text-center text-sm text-muted-foreground">
                    Select a contact to see details.
                  </div>
                )}
              </div>
            </aside>
          </div>
        </div>

        {/* Floating bulk-actions bar — appears as soon as anything is checked. */}
        {selectedIds.size > 0 && (
          <div className="pointer-events-none absolute inset-x-0 bottom-6 z-40 flex justify-center px-4">
            <div className="pointer-events-auto flex flex-wrap items-center gap-2.5 rounded-lg border border-border bg-popover px-4 py-2 shadow-[0_12px_40px_rgba(0,0,0,0.6)]">
              <span className="text-sm font-medium">{selectedIds.size} selected</span>
              <span className="h-4 w-px bg-border" aria-hidden="true" />
              <GroupPickerPopover
                disabled={false}
                groupTree={groupTree}
                onApply={bulkAssignGroups}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={selectedIds.size < 2 || selectedIds.size > 6}
                onClick={() => setMergeOpen(true)}
                title={
                  selectedIds.size < 2
                    ? "Select 2–6 contacts to merge"
                    : selectedIds.size > 6
                      ? "Merge up to 6 at a time"
                      : "Merge selected contacts"
                }
              >
                Merge…
              </Button>
              <button
                type="button"
                onClick={selectAllVisible}
                className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                Select all visible ({filtered.length})
              </button>
              <button
                type="button"
                onClick={clearSelection}
                className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                Clear
              </button>
            </div>
          </div>
        )}

        <GroupEditorDialog
          state={groupDialog}
          allGroups={gq.data?.groups ?? []}
          onClose={() => setGroupDialog(null)}
          onChanged={() => qc.invalidateQueries({ queryKey: ["contact-groups"] })}
        />

        <AddContactsDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          onAdded={() => qc.invalidateQueries({ queryKey: ["contacts"] })}
        />

        <ContactDrawer
          contactId={drawerId}
          open={!!drawerId}
          onOpenChange={(v) => !v && setDrawerId(null)}
        />
      </div>
      <GroupSuggestionsDrawer open={suggestOpen} onOpenChange={setSuggestOpen} />
      <DuplicateSuggestionsDrawer open={dupesOpen} onOpenChange={setDupesOpen} />
      <EnrichmentSuggestionsDrawer open={enrichOpen} onOpenChange={setEnrichOpen} />
      <MergeContactsDialog
        open={mergeOpen}
        onOpenChange={setMergeOpen}
        contactIds={Array.from(selectedIds)}
        onMerged={(survivorId) => {
          setSelectedIds(new Set());
          if (isPane) setPaneId(survivorId);
          else setDrawerId(survivorId);
        }}
      />
      <LabelDuplicatesDrawer open={labelDupesOpen} onOpenChange={setLabelDupesOpen} />
    </>
  );
}

function GroupChip({
  active,
  color,
  label,
  count,
  onClick,
  onEdit,
  locked,
  ai,
}: {
  active: boolean;
  color: string;
  label: string;
  count?: number;
  onClick: () => void;
  onEdit?: () => void;
  locked?: boolean;
  /** AI-derived sender category group (contact_groups.kind = ai_category). */
  ai?: boolean;
}) {
  return (
    <div
      className={`group flex items-center rounded-md text-sm ${active ? "bg-accent text-accent-foreground" : "text-foreground hover:bg-accent/40"}`}
    >
      <button
        onClick={onClick}
        className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-3 text-left"
      >
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {ai && (
          <span
            className="shrink-0 rounded-full border border-primary/40 px-1 font-mono text-[9px] uppercase text-primary"
            title="AI-derived sender category — maintained nightly"
          >
            AI
          </span>
        )}
        {/* Fixed-width, right-aligned count column so every badge shares one line. */}
        <span className="flex w-10 shrink-0 justify-end">
          {typeof count === "number" && (
            <span
              className="inline-flex min-w-[1.5rem] justify-center rounded-md border border-border/60 bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground"
              title="Contacts in this group"
            >
              {count}
            </span>
          )}
        </span>
      </button>
      {/* Always reserve the trailing slot so count badges line up across rows. */}
      {locked ? (
        <span
          className="mr-1 grid h-6 w-6 shrink-0 place-items-center rounded text-muted-foreground/70"
          title="Auto-generated from the parent group's contacts. Edit contacts' company to change this."
          aria-label="Managed automatically"
        >
          <Lock className="h-3 w-3" />
        </span>
      ) : onEdit ? (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
          className="mr-1 grid h-6 w-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-background/50 hover:text-foreground md:opacity-0 md:group-hover:opacity-100"
          aria-label={`Edit ${label}`}
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
      ) : (
        <span className="mr-1 h-6 w-6 shrink-0" aria-hidden="true" />
      )}
    </div>
  );
}

function GroupPill({
  active,
  color,
  label,
  count,
  onClick,
  onEdit,
  locked,
}: {
  active: boolean;
  color: string;
  label: string;
  count?: number;
  onClick: () => void;
  onEdit?: () => void;
  locked?: boolean;
}) {
  return (
    <div
      className={`inline-flex shrink-0 items-center rounded-full border text-xs ${active ? "border-foreground/30 bg-accent text-accent-foreground" : "border-border bg-card/60 text-foreground"}`}
    >
      <button onClick={onClick} className="flex items-center gap-1.5 py-1.5 pl-2.5 pr-1.5">
        <span className="h-2 w-2 rounded-full" style={{ background: color }} />
        <span className="max-w-[140px] truncate">{label}</span>
        {typeof count === "number" && (
          <span className="rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">
            {count}
          </span>
        )}
      </button>
      {locked && active && (
        <span
          className="mr-1 grid h-7 w-7 place-items-center rounded-full text-muted-foreground/70"
          title="Managed automatically from the parent group"
          aria-label="Managed automatically"
        >
          <Lock className="h-3.5 w-3.5" />
        </span>
      )}
      {!locked && onEdit && active && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
          className="mr-1 grid h-7 w-7 place-items-center rounded-full text-muted-foreground hover:bg-background/50 hover:text-foreground"
          aria-label={`Edit ${label}`}
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

function GroupPickerPopover({
  disabled,
  groupTree,
  onApply,
}: {
  disabled: boolean;
  groupTree: { group: GroupRow; depth: number }[];
  onApply: (groupIds: string[]) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!open) setPicked(new Set());
  }, [open]);
  function toggle(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" disabled={disabled}>
          <Plus className="mr-1.5 h-4 w-4" /> Add to group
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-2">
        {groupTree.length === 0 ? (
          <p className="p-2 text-xs text-muted-foreground">Create a group first.</p>
        ) : (
          <>
            <div className="max-h-64 overflow-y-auto">
              {groupTree.map(({ group: g, depth }) => (
                <label
                  key={g.id}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent/50"
                  style={{ paddingLeft: 8 + depth * 12 }}
                >
                  <Checkbox checked={picked.has(g.id)} onCheckedChange={() => toggle(g.id)} />
                  <span className="h-2 w-2 rounded-full" style={{ background: g.color }} />
                  <span className="truncate">{g.name}</span>
                </label>
              ))}
            </div>
            <div className="mt-2 flex justify-end gap-2 border-t border-border pt-2">
              <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={picked.size === 0}
                onClick={async () => {
                  await onApply(Array.from(picked));
                  setOpen(false);
                }}
              >
                Add
              </Button>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
