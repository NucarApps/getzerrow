import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Users,
  ScanLine,
  Search,
  IdCard,
  Plus,
  Pencil,
  Lock,
  Trash2,
  UserPlus,
  Inbox,
  Check,
  ListChecks,
  Building2,
  CalendarClock,
  Sparkles,
  Settings2,
  ChevronsDownUp,
  ChevronsUpDown,
} from "lucide-react";
import { GroupSuggestionsDrawer } from "@/components/contacts/GroupSuggestionsDrawer";
import { GroupEditorDialog, type GroupRow } from "@/components/contacts/GroupEditorDialog";
import { buildDescendantsById, buildGroupTree } from "@/lib/contacts/group-tree";
import { DuplicateSuggestionsDrawer } from "@/components/contacts/DuplicateSuggestionsDrawer";
import { MergeContactsDialog } from "@/components/contacts/MergeContactsDialog";
import { LabelDuplicatesDrawer } from "@/components/contacts/LabelDuplicatesDrawer";
import { EnrichmentSuggestionsDrawer } from "@/components/contacts/EnrichmentSuggestionsDrawer";
import { GroupRulesSection } from "@/components/contacts/GroupRulesSection";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  listContacts,
  createContactManual,
  listFoldersForPicker,
  listUniqueInboxSenders,
  bulkCreateContactsFromEmails,
} from "@/lib/contacts.functions";
import {
  listContactGroups,
  createContactGroup,
  updateContactGroup,
  deleteContactGroup,
  linkContactGroupToFolder,
  addContactsToGroups,
} from "@/lib/contact-groups.functions";
import {
  setAutoCompanySubgroups,
  reconcileAutoCompanySubgroups,
  pruneAutoCompanySubgroups,
  reconcileAllAutoGroups,
} from "@/lib/contacts/auto-company-subgroups.functions";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Label } from "@/components/ui/label";
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
import { listMeetingPeople } from "@/lib/calendar.functions";

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
});

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
  const [filter, setFilter] = useState<"all" | "ungrouped" | string>(search.group ?? "all");

  // Deep link from the Labels page ("View contacts"): follow ?group= changes.
  useEffect(() => {
    if (search.group) setFilter(search.group);
  }, [search.group]);
  const [groupDialog, setGroupDialog] = useState<
    null | { mode: "create" } | { mode: "edit"; group: GroupRow }
  >(null);
  const [addOpen, setAddOpen] = useState(false);
  const [groupByCompany, setGroupByCompany] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [dupesOpen, setDupesOpen] = useState(false);
  const [enrichOpen, setEnrichOpen] = useState(false);
  const [labelDupesOpen, setLabelDupesOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const bulkAddToGroups = useServerFn(addContactsToGroups);
  const backfillAutoGroups = useServerFn(reconcileAllAutoGroups);

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
  const q = useQuery({ queryKey: ["contacts"], queryFn: () => list() });
  const gq = useQuery({ queryKey: ["contact-groups"], queryFn: () => listGroups() });
  const aq = useQuery({ queryKey: ["company-aliases"], queryFn: () => listAliases() });
  const lq = useQuery({ queryKey: ["company-logo-choices"], queryFn: () => listLogoChoices() });
  const cq = useQuery({ queryKey: ["companies"], queryFn: () => listCompaniesFn() });

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
    const t = query.toLowerCase().trim();
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
  }, [q.data, query, filter, contactGroupMap, descendantsById]);

  const ungroupedCount = useMemo(() => {
    const all = q.data?.contacts ?? [];
    let n = 0;
    for (const c of all) if ((contactGroupMap.get(c.id)?.length ?? 0) === 0) n++;
    return n;
  }, [q.data, contactGroupMap]);

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleBucketSelection(ids: string[]) {
    if (!selectionMode) setSelectionMode(true);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const allSelected = ids.length > 0 && ids.every((id) => next.has(id));
      if (allSelected) ids.forEach((id) => next.delete(id));
      else ids.forEach((id) => next.add(id));
      return next;
    });
  }
  function handleRowClick(id: string) {
    if (selectionMode) toggleSelect(id);
    else setDrawerId(id);
  }
  function selectAllVisible() {
    setSelectedIds(new Set(filtered.map((c) => c.id)));
  }
  function clearSelection() {
    setSelectedIds(new Set());
  }
  function exitSelectionMode() {
    setSelectionMode(false);
    clearSelection();
  }
  async function bulkAssignGroups(groupIds: string[]) {
    if (!groupIds.length || selectedIds.size === 0) return;
    try {
      await bulkAddToGroups({
        data: { groupIds, contactIds: Array.from(selectedIds) },
      });
      toast.success(`Added ${selectedIds.size} contact${selectedIds.size === 1 ? "" : "s"}`);
      qc.invalidateQueries({ queryKey: ["contact-groups"] });
      exitSelectionMode();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed");
    }
  }
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

  return (
    <>
      <div className="h-full overflow-y-auto overflow-x-hidden">
        <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
          <header className="mb-6 flex items-center gap-2 sm:gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
              <Users className="h-5 w-5" />
            </div>
            <div className="flex-1 min-w-0">
              <h1 className="font-display text-xl sm:text-2xl text-foreground">Contacts</h1>
              <p className="text-xs text-muted-foreground">
                {q.data ? `${q.data.contacts.length} people` : "Loading…"}
              </p>
            </div>
            <Button variant="outline" size="sm" asChild className="px-2 sm:px-3">
              <Link to="/my-card" aria-label="My card" title="My card">
                <IdCard className="h-4 w-4 sm:mr-2" />
                <span className="hidden sm:inline">My card</span>
              </Link>
            </Button>
            <Button variant="outline" size="sm" asChild className="px-2 sm:px-3">
              <Link to="/contacts/scan" aria-label="Scan card" title="Scan card">
                <ScanLine className="h-4 w-4 sm:mr-2" />
                <span className="hidden sm:inline">Scan card</span>
              </Link>
            </Button>
            <Button
              size="sm"
              onClick={() => setAddOpen(true)}
              className="px-2 sm:px-3"
              aria-label="Add contact"
              title="Add contact"
            >
              <Plus className="h-4 w-4 sm:mr-2" />
              <span className="hidden sm:inline">Add</span>
            </Button>
          </header>

          {/* Mobile groups: horizontal pill scroller */}
          <div className="mb-4 -mx-4 px-4 md:hidden max-w-full overflow-hidden">
            <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <GroupPill
                active={filter === "all"}
                color="#a3a3a3"
                label="All"
                count={q.data?.contacts.length ?? 0}
                onClick={() => setFilter("all")}
              />
              <GroupPill
                active={filter === "ungrouped"}
                color="#71717a"
                label="Ungrouped"
                count={ungroupedCount}
                onClick={() => setFilter("ungrouped")}
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
                    onClick={() => setFilter(g.id)}
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

          <div className="grid gap-6 md:grid-cols-[220px_minmax(0,1fr)] min-w-0">
            {/* Groups rail (desktop) */}
            <aside className="hidden md:block md:sticky md:top-2 md:self-start">
              <div className="mb-2 flex items-center justify-between px-2">
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
              <div className="flex flex-col gap-0.5">
                <GroupChip
                  active={filter === "all"}
                  color="#a3a3a3"
                  label="All contacts"
                  count={q.data?.contacts.length ?? 0}
                  onClick={() => setFilter("all")}
                />
                <GroupChip
                  active={filter === "ungrouped"}
                  color="#71717a"
                  label="Ungrouped"
                  count={ungroupedCount}
                  onClick={() => setFilter("ungrouped")}
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
                        onClick={() => setFilter(g.id)}
                        onEdit={
                          isAuto ? undefined : () => setGroupDialog({ mode: "edit", group: g })
                        }
                        locked={isAuto}
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

            {/* Main list */}
            <div className="min-w-0">
              <div className="mb-4 flex items-center gap-2">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder="Search by name, email, or company…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    className="pl-9"
                  />
                </div>
                <Button
                  variant={groupByCompany ? "default" : "outline"}
                  size="sm"
                  onClick={() => setGroupByCompany((v) => !v)}
                  title="Group by company"
                  aria-pressed={groupByCompany}
                  className="shrink-0 px-2 sm:px-3"
                >
                  <Building2 className="h-4 w-4 sm:mr-2" />
                  <span className="hidden sm:inline">By company</span>
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
                    className="shrink-0 px-2 sm:px-3"
                  >
                    {allBucketsCollapsed ? (
                      <ChevronsUpDown className="h-4 w-4 sm:mr-2" />
                    ) : (
                      <ChevronsDownUp className="h-4 w-4 sm:mr-2" />
                    )}
                    <span className="hidden sm:inline">
                      {allBucketsCollapsed ? "Expand all" : "Collapse all"}
                    </span>
                  </Button>
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      title="AI tools"
                      className="shrink-0 px-2 sm:px-3"
                    >
                      <Sparkles className="h-4 w-4 sm:mr-2" />
                      <span className="hidden sm:inline">AI tools</span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => setSuggestOpen(true)}>
                      Suggest groups
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setDupesOpen(true)}>
                      Find duplicate contacts
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setLabelDupesOpen(true)}>
                      Find duplicate labels
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setEnrichOpen(true)}>
                      Enrich from inbox
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button
                  variant={selectionMode ? "default" : "outline"}
                  size="sm"
                  onClick={() => (selectionMode ? exitSelectionMode() : setSelectionMode(true))}
                  title="Select multiple"
                  aria-pressed={selectionMode}
                  className="shrink-0 px-2 sm:px-3"
                >
                  <ListChecks className="h-4 w-4 sm:mr-2" />
                  <span className="hidden sm:inline">{selectionMode ? "Done" : "Select"}</span>
                </Button>
              </div>

              {selectionMode && (
                <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-border bg-accent/30 px-3 py-2 text-sm">
                  <span className="font-medium">{selectedIds.size} selected</span>
                  <button
                    type="button"
                    onClick={selectAllVisible}
                    className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  >
                    Select all visible ({filtered.length})
                  </button>
                  {selectedIds.size > 0 && (
                    <button
                      type="button"
                      onClick={clearSelection}
                      className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                    >
                      Clear
                    </button>
                  )}
                  <div className="ml-auto flex items-center gap-2">
                    <GroupPickerPopover
                      disabled={selectedIds.size === 0}
                      groupTree={groupTree}
                      onApply={bulkAssignGroups}
                    />
                  </div>
                </div>
              )}

              {q.isLoading ? (
                <div className="grid gap-2">
                  {Array.from({ length: 8 }).map((_, i) => (
                    <div
                      key={i}
                      className="h-14 animate-pulse rounded-md border border-border bg-card/40"
                    />
                  ))}
                </div>
              ) : filtered.length === 0 ? (
                <p className="py-12 text-center text-sm text-muted-foreground">
                  {query ? "No matches." : "No contacts yet. Scan a card or add one manually."}
                </p>
              ) : groupByCompany ? (
                <div className="space-y-3">
                  {companyBuckets.map((b) => {
                    const isCollapsed = collapsed.has(b.key);
                    return (
                      <section key={b.key} className="overflow-hidden rounded-md">
                        <CompanyBucketHeader
                          domain={b.domain}
                          name={b.name}
                          count={b.contacts.length}
                          collapsed={isCollapsed}
                          onToggle={() => toggleBucket(b.key)}
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
                          selectable={selectionMode}
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
                            <div className="flex flex-wrap items-center gap-2 border-x border-border bg-amber-500/10 px-3 py-2 text-xs text-foreground">
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
                          <ul className="divide-y divide-border border-x border-b border-border bg-card/40">
                            {b.contacts.map((c) => {
                              const gids = contactGroupMap.get(c.id) ?? [];
                              return (
                                <li key={c.id}>
                                  <button
                                    onClick={() => handleRowClick(c.id)}
                                    className={`flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-accent/40 ${selectionMode && selectedIds.has(c.id) ? "bg-accent/50" : ""}`}
                                  >
                                    {selectionMode && (
                                      <Checkbox
                                        checked={selectedIds.has(c.id)}
                                        onCheckedChange={() => toggleSelect(c.id)}
                                        onClick={(e) => e.stopPropagation()}
                                      />
                                    )}
                                    <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
                                      {(c.name || c.email || "?").slice(0, 1).toUpperCase()}
                                    </div>
                                    <div className="min-w-0 flex-1">
                                      <div className="truncate text-sm font-medium text-foreground">
                                        {c.name || c.email}
                                      </div>
                                      {b.kind === "company" ? (
                                        <>
                                          <div className="truncate text-xs text-muted-foreground">
                                            {c.title || c.email}
                                          </div>
                                          {c.relationship_summary && (
                                            <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground/80">
                                              {c.relationship_summary}
                                            </div>
                                          )}
                                        </>
                                      ) : (
                                        <div className="truncate text-xs text-muted-foreground">
                                          {c.email}
                                        </div>
                                      )}
                                    </div>
                                    {gids.length > 0 && (
                                      <div className="flex items-center gap-1">
                                        {gids.slice(0, 4).map((gid) => {
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
                                    )}
                                  </button>
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </section>
                    );
                  })}
                </div>
              ) : (
                <ul className="divide-y divide-border rounded-md border border-border bg-card/40">
                  {filtered.map((c) => {
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
                    const personInitial = (c.name || c.email || "?").trim().charAt(0).toUpperCase();
                    return (
                      <li key={c.id}>
                        <button
                          onClick={() => handleRowClick(c.id)}
                          className={`flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-accent/40 ${selectionMode && selectedIds.has(c.id) ? "bg-accent/50" : ""}`}
                        >
                          {selectionMode && (
                            <Checkbox
                              checked={selectedIds.has(c.id)}
                              onCheckedChange={() => toggleSelect(c.id)}
                              onClick={(e) => e.stopPropagation()}
                            />
                          )}
                          {showLogo ? (
                            <CompanyLogo
                              domain={resolvedDom ?? dom}
                              name={personInitial}
                              size={40}
                              className="rounded-full"
                              provider={logoProv}
                              sourceDomain={logoSrc}
                            />
                          ) : (
                            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-primary/15 text-sm font-semibold text-primary">
                              {personInitial}
                            </div>
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium text-foreground">
                              {c.name || c.email}
                            </div>
                            <div className="truncate text-xs text-muted-foreground">
                              {c.company ? `${c.company} · ` : ""}
                              {c.email}
                            </div>
                          </div>
                          {gids.length > 0 && (
                            <div className="flex items-center gap-1">
                              {gids.slice(0, 4).map((gid) => {
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
                          )}
                          {c.source === "scan" && (
                            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] uppercase tracking-wide text-amber-400">
                              scanned
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        </div>

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
      className={`group flex items-center rounded-md text-sm ${active ? "bg-accent text-accent-foreground" : "text-foreground hover:bg-accent/40"}`}
    >
      <button
        onClick={onClick}
        className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-3 text-left"
      >
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
        <span className="min-w-0 flex-1 truncate">{label}</span>
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
          className="mr-1 grid h-5 w-5 place-items-center rounded-full text-muted-foreground/70"
          title="Managed automatically from the parent group"
          aria-label="Managed automatically"
        >
          <Lock className="h-3 w-3" />
        </span>
      )}
      {!locked && onEdit && active && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
          className="mr-1 grid h-5 w-5 place-items-center rounded-full text-muted-foreground hover:bg-background/50 hover:text-foreground"
          aria-label={`Edit ${label}`}
        >
          <Pencil className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

function AddContactsDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onAdded: () => void;
}) {
  const createManual = useServerFn(createContactManual);
  const listFolders = useServerFn(listFoldersForPicker);
  const listSenders = useServerFn(listUniqueInboxSenders);
  const listMeeting = useServerFn(listMeetingPeople);
  const bulkAdd = useServerFn(bulkCreateContactsFromEmails);

  const [tab, setTab] = useState<"manual" | "inbox" | "meetings">("manual");

  // Manual form state
  const [m, setM] = useState({
    email: "",
    name: "",
    title: "",
    company: "",
    phone: "",
    website: "",
    linkedin: "",
    twitter: "",
  });
  const [saving, setSaving] = useState(false);

  // Inbox tab state
  const [folderIds, setFolderIds] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);

  // Meetings tab state
  const [meetingWhen, setMeetingWhen] = useState<"past" | "upcoming">("past");

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    if (!open) {
      setM({
        email: "",
        name: "",
        title: "",
        company: "",
        phone: "",
        website: "",
        linkedin: "",
        twitter: "",
      });
      setFolderIds([]);
      setSearch("");
      setDebounced("");
      setSelected(new Set());
      setTab("manual");
      setMeetingWhen("past");
    }
  }, [open]);

  const foldersQ = useQuery({
    queryKey: ["folders-picker"],
    queryFn: () => listFolders(),
    enabled: open,
  });

  const sendersQ = useQuery({
    queryKey: ["inbox-senders", folderIds.join(","), debounced],
    queryFn: () =>
      listSenders({
        data: {
          folderIds: folderIds.length ? folderIds : undefined,
          search: debounced || undefined,
        },
      }),
    enabled: open && tab === "inbox",
  });

  const meetingsQ = useQuery({
    queryKey: ["meeting-people", meetingWhen, debounced],
    queryFn: () => listMeeting({ data: { when: meetingWhen, search: debounced || undefined } }),
    enabled: open && tab === "meetings",
  });

  async function submitManual() {
    if (!/.+@.+\..+/.test(m.email)) {
      toast.error("Enter a valid email");
      return;
    }
    setSaving(true);
    try {
      await createManual({
        data: {
          email: m.email,
          name: m.name || null,
          title: m.title || null,
          company: m.company || null,
          phone: m.phone || null,
          website: m.website || null,
          linkedin: m.linkedin || null,
          twitter: m.twitter || null,
        },
      });
      toast.success("Contact added");
      onAdded();
      onOpenChange(false);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Couldn't add contact");
    } finally {
      setSaving(false);
    }
  }

  function toggleFolder(id: string) {
    setFolderIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function toggleSender(email: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email);
      else next.add(email);
      return next;
    });
  }

  const senders = sendersQ.data?.senders ?? [];
  const meetingPeople = meetingsQ.data?.people ?? [];
  const meetingAccess = meetingsQ.data?.calendarAccess ?? true;

  // The list the picker currently shows (inbox senders or meeting people).
  const pickerItems = tab === "meetings" ? meetingPeople : senders;
  const allVisibleSelected =
    pickerItems.length > 0 && pickerItems.every((s) => selected.has(s.email));

  function selectAllVisible() {
    if (allVisibleSelected) {
      setSelected((prev) => {
        const next = new Set(prev);
        for (const s of pickerItems) next.delete(s.email);
        return next;
      });
    } else {
      setSelected((prev) => {
        const next = new Set(prev);
        for (const s of pickerItems) next.add(s.email);
        return next;
      });
    }
  }

  async function submitBulk() {
    if (selected.size === 0) return;
    const items = pickerItems
      .filter((s) => selected.has(s.email))
      .map((s) => ({ email: s.email, name: s.name }));
    if (items.length === 0) return;
    setAdding(true);
    try {
      const r = await bulkAdd({ data: { items } });
      toast.success(`Added ${r.created} ${r.created === 1 ? "contact" : "contacts"}`);
      onAdded();
      onOpenChange(false);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Couldn't add contacts");
    } finally {
      setAdding(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Add contacts</DialogTitle>
          <DialogDescription>
            Enter someone manually, or pick from your inbox senders or calendar meetings.
          </DialogDescription>
        </DialogHeader>

        <Tabs
          value={tab}
          onValueChange={(v) => {
            setSelected(new Set());
            setSearch("");
            setDebounced("");
            setTab(v as typeof tab);
          }}
          className="flex-1 flex flex-col min-h-0"
        >
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="manual">
              <UserPlus className="mr-2 h-4 w-4" /> Manual
            </TabsTrigger>
            <TabsTrigger value="inbox">
              <Inbox className="mr-2 h-4 w-4" /> From inbox
            </TabsTrigger>
            <TabsTrigger value="meetings">
              <CalendarClock className="mr-2 h-4 w-4" /> From meetings
            </TabsTrigger>
          </TabsList>

          <TabsContent value="manual" className="space-y-3 pt-3 overflow-y-auto">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Email *">
                <Input
                  type="email"
                  value={m.email}
                  onChange={(e) => setM({ ...m, email: e.target.value })}
                  placeholder="person@example.com"
                  autoFocus
                />
              </Field>
              <Field label="Name">
                <Input
                  value={m.name}
                  onChange={(e) => setM({ ...m, name: e.target.value })}
                  placeholder="Jane Doe"
                />
              </Field>
              <Field label="Title">
                <Input value={m.title} onChange={(e) => setM({ ...m, title: e.target.value })} />
              </Field>
              <Field label="Company">
                <Input
                  value={m.company}
                  onChange={(e) => setM({ ...m, company: e.target.value })}
                />
              </Field>
              <Field label="Phone">
                <Input value={m.phone} onChange={(e) => setM({ ...m, phone: e.target.value })} />
              </Field>
              <Field label="Website">
                <Input
                  value={m.website}
                  onChange={(e) => setM({ ...m, website: e.target.value })}
                />
              </Field>
              <Field label="LinkedIn">
                <Input
                  value={m.linkedin}
                  onChange={(e) => setM({ ...m, linkedin: e.target.value })}
                />
              </Field>
              <Field label="Twitter / X">
                <Input
                  value={m.twitter}
                  onChange={(e) => setM({ ...m, twitter: e.target.value })}
                />
              </Field>
            </div>
            <DialogFooter className="pt-2">
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={submitManual} disabled={saving || !m.email}>
                {saving ? "Adding…" : "Add contact"}
              </Button>
            </DialogFooter>
          </TabsContent>

          <TabsContent value="inbox" className="flex flex-col min-h-0 pt-3 gap-3">
            <div>
              <Label className="mb-1.5 block text-xs uppercase tracking-widest text-muted-foreground">
                Search in folders
              </Label>
              <div className="flex flex-wrap gap-1.5">
                <button
                  onClick={() => setFolderIds([])}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${folderIds.length === 0 ? "border-foreground/40 bg-accent text-accent-foreground" : "border-border bg-card/60 text-muted-foreground hover:text-foreground"}`}
                >
                  All folders
                </button>
                {(foldersQ.data?.folders ?? []).map((f) => {
                  const on = folderIds.includes(f.id);
                  return (
                    <button
                      key={f.id}
                      onClick={() => toggleFolder(f.id)}
                      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${on ? "border-foreground/40 bg-accent text-accent-foreground" : "border-border bg-card/60 text-foreground hover:bg-accent/40"}`}
                    >
                      <span className="h-2 w-2 rounded-full" style={{ background: f.color }} />
                      {f.name}
                      {on && <Check className="h-3 w-3" />}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search senders by name or email…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9"
              />
            </div>

            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <button
                onClick={selectAllVisible}
                disabled={senders.length === 0}
                className="underline-offset-2 hover:underline disabled:opacity-50"
              >
                {allVisibleSelected ? "Unselect all" : "Select all visible"}
              </button>
              <span>{selected.size} selected</span>
            </div>

            <div className="flex-1 min-h-[200px] max-h-[40vh] overflow-y-auto rounded-md border border-border bg-card/40">
              {sendersQ.isLoading ? (
                <div className="p-4 text-sm text-muted-foreground">Loading senders…</div>
              ) : senders.length === 0 ? (
                <div className="p-4 text-sm text-muted-foreground">
                  No new senders found in this scope.
                </div>
              ) : (
                <ul className="divide-y divide-border">
                  {senders.map((s) => {
                    const checked = selected.has(s.email);
                    return (
                      <li key={s.email}>
                        <button
                          onClick={() => toggleSender(s.email)}
                          className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-accent/40"
                        >
                          <span
                            className={`grid h-5 w-5 shrink-0 place-items-center rounded border ${checked ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background"}`}
                          >
                            {checked && <Check className="h-3.5 w-3.5" />}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium text-foreground">
                              {s.name || s.email}
                            </div>
                            <div className="truncate text-xs text-muted-foreground">{s.email}</div>
                          </div>
                          <div className="text-right text-[11px] text-muted-foreground shrink-0">
                            <div>
                              {s.count} {s.count === 1 ? "msg" : "msgs"}
                            </div>
                            {s.lastReceivedAt && (
                              <div>{new Date(s.lastReceivedAt).toLocaleDateString()}</div>
                            )}
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={adding}>
                Cancel
              </Button>
              <Button onClick={submitBulk} disabled={adding || selected.size === 0}>
                {adding
                  ? "Adding…"
                  : `Add ${selected.size || ""} ${selected.size === 1 ? "contact" : "contacts"}`}
              </Button>
            </DialogFooter>
          </TabsContent>

          <TabsContent value="meetings" className="flex flex-col min-h-0 pt-3 gap-3">
            <div className="flex flex-wrap items-center gap-1.5">
              {(["past", "upcoming"] as const).map((w) => (
                <button
                  key={w}
                  onClick={() => {
                    setMeetingWhen(w);
                    setSelected(new Set());
                  }}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs ${meetingWhen === w ? "border-foreground/40 bg-accent text-accent-foreground" : "border-border bg-card/60 text-muted-foreground hover:text-foreground"}`}
                >
                  {w === "past" ? "Past meetings" : "Upcoming meetings"}
                </button>
              ))}
            </div>

            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search people by name or email…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9"
              />
            </div>

            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <button
                onClick={selectAllVisible}
                disabled={meetingPeople.length === 0}
                className="underline-offset-2 hover:underline disabled:opacity-50"
              >
                {allVisibleSelected ? "Unselect all" : "Select all visible"}
              </button>
              <span>{selected.size} selected</span>
            </div>

            <div className="flex-1 min-h-[200px] max-h-[40vh] overflow-y-auto rounded-md border border-border bg-card/40">
              {!meetingAccess ? (
                <div className="p-4 text-sm text-muted-foreground">
                  Connect a Google account and enable calendar access in{" "}
                  <Link to="/settings" className="text-foreground underline underline-offset-2">
                    Settings
                  </Link>{" "}
                  to pull people from your meetings.
                </div>
              ) : meetingsQ.isLoading ? (
                <div className="p-4 text-sm text-muted-foreground">
                  Loading people from your calendar…
                </div>
              ) : meetingPeople.length === 0 ? (
                <div className="p-4 text-sm text-muted-foreground">
                  No new people found in your {meetingWhen} meetings.
                </div>
              ) : (
                <ul className="divide-y divide-border">
                  {meetingPeople.map((p) => {
                    const checked = selected.has(p.email);
                    return (
                      <li key={p.email}>
                        <button
                          onClick={() => toggleSender(p.email)}
                          className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-accent/40"
                        >
                          <span
                            className={`grid h-5 w-5 shrink-0 place-items-center rounded border ${checked ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background"}`}
                          >
                            {checked && <Check className="h-3.5 w-3.5" />}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium text-foreground">
                              {p.name || p.email}
                            </div>
                            <div className="truncate text-xs text-muted-foreground">
                              {p.eventTitle ? `${p.email} · ${p.eventTitle}` : p.email}
                            </div>
                          </div>
                          {p.meetingAt && (
                            <div className="text-right text-[11px] text-muted-foreground shrink-0">
                              {new Date(p.meetingAt).toLocaleDateString()}
                            </div>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={adding}>
                Cancel
              </Button>
              <Button onClick={submitBulk} disabled={adding || selected.size === 0}>
                {adding
                  ? "Adding…"
                  : `Add ${selected.size || ""} ${selected.size === 1 ? "contact" : "contacts"}`}
              </Button>
            </DialogFooter>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Label className="mb-1 block text-xs text-muted-foreground">{label}</Label>
      {children}
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
