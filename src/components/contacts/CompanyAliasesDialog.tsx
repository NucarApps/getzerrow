import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { X, Plus, Trash2, Check, Star } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import {
  addCompanyAlias,
  removeCompanyAlias,
  clearCompanyAliases,
  promoteAliasToPrimary,
} from "@/lib/company-aliases.functions";
import {
  renameCompanyForContacts,
  setCompanyWebsiteForContacts,
} from "@/lib/contacts/crud.functions";

import {
  listCompanyLogoChoices,
  setCompanyLogoChoice,
  clearCompanyLogoChoice,
} from "@/lib/company-logo.functions";
import { listCompanyGroupAssignments, setCompanyGroups } from "@/lib/company-groups.functions";
import { listContactGroups } from "@/lib/contact-groups.functions";
import { searchLogoBrands, type LogoBrand } from "@/lib/logo-search.functions";
import { LOGO_PROVIDER_LABELS } from "@/lib/logo-providers";
import { logoCandidates } from "@/lib/company-domains";
import { CompanyLogo } from "./CompanyLogo";

type Props = {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  primaryDomain: string | null;
  companyName: string;
  aliases: string[];
  contactIds: string[];
};

export function CompanyAliasesDialog({
  open,
  onOpenChange,
  primaryDomain,
  companyName,
  aliases,
  contactIds,
}: Props) {
  const qc = useQueryClient();
  const addFn = useServerFn(addCompanyAlias);
  const removeFn = useServerFn(removeCompanyAlias);
  const clearFn = useServerFn(clearCompanyAliases);
  const promoteFn = useServerFn(promoteAliasToPrimary);
  const listChoices = useServerFn(listCompanyLogoChoices);
  const setChoiceFn = useServerFn(setCompanyLogoChoice);
  const clearChoiceFn = useServerFn(clearCompanyLogoChoice);
  const listAssignments = useServerFn(listCompanyGroupAssignments);
  const listGroups = useServerFn(listContactGroups);
  const setGroupsFn = useServerFn(setCompanyGroups);
  const searchBrandsFn = useServerFn(searchLogoBrands);
  const renameFn = useServerFn(renameCompanyForContacts);
  const setWebsiteFn = useServerFn(setCompanyWebsiteForContacts);

  const [newDomain, setNewDomain] = useState("");
  const [primaryDraft, setPrimaryDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<string>>(new Set());
  const [brandQuery, setBrandQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [nameDraft, setNameDraft] = useState(companyName);

  const choicesQ = useQuery({
    queryKey: ["company-logo-choices"],
    queryFn: () => listChoices(),
    enabled: open,
  });
  const currentRow = primaryDomain
    ? choicesQ.data?.find((c) => c.domain === primaryDomain)
    : undefined;
  const currentProvider = currentRow?.provider ?? null;
  const currentSource = currentRow?.source_domain ?? null;

  const assignmentsQ = useQuery({
    queryKey: ["company-group-assignments"],
    queryFn: () => listAssignments(),
    enabled: open,
  });
  const groupsQ = useQuery({
    queryKey: ["contact-groups"],
    queryFn: () => listGroups(),
    enabled: open,
  });

  const savedGroupIds = primaryDomain
    ? (assignmentsQ.data ?? [])
        .filter((a) => a.primary_domain === primaryDomain)
        .map((a) => a.group_id)
    : [];

  // Per-group membership counts across the contacts in this bucket, so we can
  // seed the selection and show partial ("3/5") coverage in the chip UI.
  const contactIdSet = new Set(contactIds);
  const memberCountByGroup = new Map<string, number>();
  for (const m of groupsQ.data?.memberships ?? []) {
    if (contactIdSet.has(m.contact_id)) {
      memberCountByGroup.set(m.group_id, (memberCountByGroup.get(m.group_id) ?? 0) + 1);
    }
  }
  const fullyCoveredGroupIds =
    contactIds.length > 0
      ? [...memberCountByGroup.entries()]
          .filter(([, n]) => n === contactIds.length)
          .map(([id]) => id)
      : [];
  const initialSelection = Array.from(new Set([...savedGroupIds, ...fullyCoveredGroupIds]));
  const savedKey = initialSelection.slice().sort().join(",");

  useEffect(() => {
    if (open) setSelectedGroupIds(new Set(initialSelection));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, savedKey]);


  useEffect(() => {
    if (open) {
      setBrandQuery(companyName ?? "");
      setNameDraft(companyName ?? "");
      setPrimaryDraft("");
    } else {
      setNewDomain("");
      setPrimaryDraft("");
      setBrandQuery("");
      setDebouncedQuery("");
    }
  }, [open, companyName]);


  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(brandQuery.trim()), 300);
    return () => clearTimeout(t);
  }, [brandQuery]);

  const brandsQ = useQuery({
    queryKey: ["logo-brand-search", debouncedQuery],
    queryFn: () => searchBrandsFn({ data: { query: debouncedQuery } }),
    enabled: open && debouncedQuery.length >= 2,
    staleTime: 60_000,
  });

  const hasPrimary = !!primaryDomain;

  async function savePrimary() {
    const d = primaryDraft
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/\/.*$/, "");
    if (!d) return;
    if (!/^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(d)) {
      toast.error("Enter a valid domain (e.g. acme.com)");
      return;
    }
    setBusy(true);
    try {
      await setWebsiteFn({ data: { contactIds, website: `https://${d}` } });
      toast.success(`Set ${d} as the primary domain`);
      qc.invalidateQueries({ queryKey: ["contacts"] });
      setPrimaryDraft("");
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't set domain");
    } finally {
      setBusy(false);
    }
  }


  function invalidate() {
    qc.invalidateQueries({ queryKey: ["company-aliases"] });
  }

  async function add() {
    const d = newDomain
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "");
    if (!d) return;
    setBusy(true);
    try {
      await addFn({ data: { primaryDomain: primaryDomain!, aliasDomain: d } });
      toast.success(`Merged ${d}`);
      setNewDomain("");
      invalidate();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Couldn't add domain";
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  }

  async function remove(alias: string) {
    setBusy(true);
    try {
      await removeFn({ data: { aliasDomain: alias } });
      invalidate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't remove");
    } finally {
      setBusy(false);
    }
  }

  async function clearAll() {
    if (aliases.length === 0) {
      onOpenChange(false);
      return;
    }
    if (
      !confirm(
        `Remove all ${aliases.length} merged ${aliases.length === 1 ? "domain" : "domains"}?`,
      )
    )
      return;
    setBusy(true);
    try {
      await clearFn({ data: { primaryDomain: primaryDomain! } });
      toast.success("Merge cleared");
      invalidate();
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't clear");
    } finally {
      setBusy(false);
    }
  }

  async function pickLogo(provider: number | null, sourceDomain: string) {
    setBusy(true);
    try {
      if (provider === null && sourceDomain === primaryDomain) {
        await clearChoiceFn({ data: { domain: primaryDomain! } });
      } else {
        // "Auto" for an alias source means provider 0 (Clearbit) from that domain.
        const p = provider ?? 0;
        await setChoiceFn({ data: { domain: primaryDomain!, provider: p, sourceDomain } });
      }
      qc.invalidateQueries({ queryKey: ["company-logo-choices"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save logo choice");
    } finally {
      setBusy(false);
    }
  }

  async function pickBrand(brand: LogoBrand) {
    setBusy(true);
    try {
      await setChoiceFn({
        data: { domain: primaryDomain!, provider: 0, sourceDomain: brand.domain },
      });
      toast.success(`Using ${brand.name} logo`);
      qc.invalidateQueries({ queryKey: ["company-logo-choices"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save logo choice");
    } finally {
      setBusy(false);
    }
  }

  async function promote(alias: string) {
    if (!confirm(`Make ${alias} the primary domain for this company?`)) return;
    setBusy(true);
    try {
      await promoteFn({ data: { currentPrimary: primaryDomain!, newPrimary: alias } });
      toast.success(`${alias} is now the primary`);
      qc.invalidateQueries({ queryKey: ["company-aliases"] });
      qc.invalidateQueries({ queryKey: ["company-logo-choices"] });
      qc.invalidateQueries({ queryKey: ["company-group-assignments"] });
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't promote");
    } finally {
      setBusy(false);
    }
  }

  async function saveTags() {
    setBusy(true);
    try {
      const groupIds = [...selectedGroupIds];
      const res = await setGroupsFn({
        data: { primaryDomain: primaryDomain!, contactIds, groupIds },
      });
      toast.success(
        groupIds.length === 0
          ? "Tags cleared for this company"
          : `Tagged ${res.tagged} ${res.tagged === 1 ? "contact" : "contacts"}`,
      );
      qc.invalidateQueries({ queryKey: ["company-group-assignments"] });
      qc.invalidateQueries({ queryKey: ["contact-groups"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save tags");
    } finally {
      setBusy(false);
    }
  }

  async function saveName() {
    const next = nameDraft.trim();
    if (!next || next === companyName) return;
    setBusy(true);
    try {
      const res = await renameFn({ data: { contactIds, newName: next } });
      toast.success(
        `Renamed ${res.updated} ${res.updated === 1 ? "contact" : "contacts"} to ${next}`,
      );
      qc.invalidateQueries({ queryKey: ["contacts"] });
      qc.invalidateQueries({ queryKey: ["company-aliases"] });
      qc.invalidateQueries({ queryKey: ["company-group-assignments"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't rename company");
    } finally {
      setBusy(false);
    }
  }

  function toggleGroup(id: string) {
    setSelectedGroupIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const groups = groupsQ.data?.groups ?? [];
  const tagsDirty =
    [...selectedGroupIds].sort().join(",") !== initialSelection.slice().sort().join(",");


  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] flex-col sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <CompanyLogo
              domain={primaryDomain}
              name={companyName}
              size={28}
              provider={currentProvider}
              sourceDomain={currentSource}
            />
            <Input
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void saveName();
                } else if (e.key === "Escape") {
                  setNameDraft(companyName);
                }
              }}
              disabled={busy}
              placeholder="Company name"
              className="h-8 flex-1 text-base font-semibold"
              aria-label="Company name"
            />
            {nameDraft.trim() && nameDraft.trim() !== companyName && (
              <>
                <Button size="sm" onClick={saveName} disabled={busy}>
                  Save
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setNameDraft(companyName)}
                  disabled={busy}
                >
                  Cancel
                </Button>
              </>
            )}
          </DialogTitle>
          <DialogDescription>
            Rename the company (applies to all {contactIds.length}{" "}
            {contactIds.length === 1 ? "contact" : "contacts"} in this bucket), merge domains, and
            pick which logo to show.
          </DialogDescription>
        </DialogHeader>

        <div className="-mx-6 flex-1 space-y-4 overflow-y-auto px-6">
          <div>
            <Label className="text-xs uppercase tracking-widest text-muted-foreground">
              Primary domain
            </Label>
            {hasPrimary ? (
              <div className="mt-1 inline-flex items-center rounded-md border border-border bg-muted/40 px-2.5 py-1 text-sm">
                {primaryDomain}
              </div>
            ) : (
              <div className="mt-1 space-y-1.5">
                <div className="flex gap-2">
                  <Input
                    value={primaryDraft}
                    onChange={(e) => setPrimaryDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void savePrimary();
                      }
                    }}
                    placeholder="acme.com"
                    disabled={busy}
                  />
                  <Button onClick={savePrimary} disabled={busy || !primaryDraft.trim()} size="sm">
                    Save
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Sets the website on all {contactIds.length}{" "}
                  {contactIds.length === 1 ? "contact" : "contacts"} in this bucket, which enables
                  logo and group assignments below.
                </p>
              </div>
            )}
          </div>



          {hasPrimary && (
          <>
          <div>


            <Label className="text-xs uppercase tracking-widest text-muted-foreground">Logo</Label>
            <div className="mt-2 rounded-md border border-border bg-card/40 p-2.5">
              <Input
                value={brandQuery}
                onChange={(e) => setBrandQuery(e.target.value)}
                placeholder="Search logos by company name"
                disabled={busy}
              />
              {debouncedQuery.length >= 2 && (
                <div className="mt-2">
                  {brandsQ.isFetching ? (
                    <p className="text-[11px] text-muted-foreground">Searching…</p>
                  ) : (brandsQ.data?.results.length ?? 0) === 0 ? (
                    <p className="text-[11px] text-muted-foreground">No matches.</p>
                  ) : (
                    <div className="grid grid-cols-5 gap-2">
                      {brandsQ.data!.results.map((b) => {
                        const selected = currentSource === b.domain && currentProvider === 0;
                        return (
                          <button
                            key={b.domain}
                            type="button"
                            onClick={() => pickBrand(b)}
                            disabled={busy}
                            title={`${b.name} (${b.domain})`}
                            aria-pressed={selected}
                            className={`relative grid aspect-square place-items-center overflow-hidden rounded-md border bg-white p-1.5 transition disabled:opacity-50 ${
                              selected
                                ? "border-primary ring-2 ring-primary/40"
                                : "border-border hover:border-primary/60"
                            }`}
                          >
                            <img
                              src={logoCandidates(b.domain, 256, 0)[0]}
                              alt={b.name}
                              loading="lazy"
                              referrerPolicy="no-referrer"
                              className="h-full w-full object-contain"
                            />
                            {selected && (
                              <span className="absolute right-1 top-1 grid h-4 w-4 place-items-center rounded-full bg-primary text-primary-foreground">
                                <Check className="h-3 w-3" />
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="mt-3 space-y-3">
              {[primaryDomain, ...aliases].map((d) => {
                const isActiveSource = (currentSource ?? primaryDomain) === d;
                return (
                  <div key={d}>
                    <div className="mb-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                      <span className="truncate">{d}</span>
                      {d === primaryDomain && (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wider">
                          primary
                        </span>
                      )}
                    </div>
                    <div className="grid grid-cols-4 gap-2">
                      {d === primaryDomain && (
                        <LogoTile
                          label="Auto"
                          domain={d}
                          provider={null}
                          selected={isActiveSource && currentProvider === null}
                          disabled={busy}
                          onSelect={() => pickLogo(null, d)}
                        />
                      )}
                      {LOGO_PROVIDER_LABELS.map((label, i) => (
                        <LogoTile
                          key={`${d}-${i}`}
                          label={label}
                          domain={d}
                          provider={i}
                          selected={isActiveSource && currentProvider === i}
                          disabled={busy}
                          onSelect={() => pickLogo(i, d)}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Tiles that can't load are hidden. Auto picks the first one that works on the primary
              domain.
            </p>
          </div>

          <div>
            <div className="flex items-center justify-between gap-2">
              <Label className="text-xs uppercase tracking-widest text-muted-foreground">
                Tags
              </Label>
              <span className="text-[11px] text-muted-foreground">
                {contactIds.length} {contactIds.length === 1 ? "contact" : "contacts"}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {groups.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No tags yet. Create one from the contacts page first.
                </p>
              ) : (
                groups.map((g) => {
                  const active = selectedGroupIds.has(g.id);
                  const n = memberCountByGroup.get(g.id) ?? 0;
                  const partial = n > 0 && n < contactIds.length;
                  return (
                    <button
                      key={g.id}
                      type="button"
                      onClick={() => toggleGroup(g.id)}
                      disabled={busy}
                      aria-pressed={active}
                      title={
                        n > 0
                          ? `${n} of ${contactIds.length} contacts already in ${g.name}`
                          : undefined
                      }
                      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition disabled:opacity-50 ${
                        active
                          ? "border-primary bg-primary/10 text-foreground"
                          : "border-border bg-card/40 text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: g.color }} />
                      <span className="truncate max-w-[10rem]">{g.name}</span>
                      {partial && (
                        <span className="rounded bg-muted px-1 py-px text-[10px] font-medium text-muted-foreground">
                          {n}/{contactIds.length}
                        </span>
                      )}
                      {active && <Check className="h-3 w-3" />}
                    </button>
                  );
                })

              )}
            </div>
            {groups.length > 0 && (
              <div className="mt-2 flex items-center justify-between">
                <p className="text-[11px] text-muted-foreground">
                  Tags apply to all {contactIds.length} {contactIds.length === 1 ? "contact" : "contacts"}. Partial chips (n/N) show how many are already members.
                </p>
                <Button
                  size="sm"
                  variant={tagsDirty ? "default" : "outline"}
                  onClick={saveTags}
                  disabled={busy || !tagsDirty}
                >
                  Save tags
                </Button>
              </div>
            )}
          </div>

          <div>
            <Label className="text-xs uppercase tracking-widest text-muted-foreground">
              Other domains for this company
            </Label>
            <div className="mt-1 space-y-1">
              {aliases.length === 0 ? (
                <p className="text-xs text-muted-foreground">No merged domains yet.</p>
              ) : (
                aliases.map((a) => (
                  <div
                    key={a}
                    className="flex items-center gap-2 rounded-md border border-border bg-card/40 px-2.5 py-1.5 text-sm"
                  >
                    <span className="flex-1 truncate">{a}</span>
                    <button
                      onClick={() => promote(a)}
                      disabled={busy}
                      aria-label={`Make ${a} primary`}
                      title="Make primary"
                      className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      <Star className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => remove(a)}
                      disabled={busy}
                      aria-label={`Remove ${a}`}
                      title="Remove"
                      className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))
              )}
            </div>
            <div className="mt-2 flex gap-2">
              <Input
                value={newDomain}
                onChange={(e) => setNewDomain(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void add();
                  }
                }}
                placeholder="acme.io"
                disabled={busy}
              />
              <Button onClick={add} disabled={busy || !newDomain.trim()} size="sm">
                <Plus className="mr-1 h-4 w-4" /> Add
              </Button>
            </div>
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              If that domain is already its own company, it will be merged in.
            </p>
          </div>
          </>
          )}
        </div>



        <DialogFooter className="gap-2 sm:gap-0">
          {aliases.length > 0 && (
            <Button
              variant="ghost"
              className="mr-auto text-destructive"
              onClick={clearAll}
              disabled={busy}
            >
              <Trash2 className="mr-1.5 h-4 w-4" /> Delete merge
            </Button>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type TileProps = {
  label: string;
  domain: string;
  provider: number | null;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
};

function LogoTile({ label, domain, provider, selected, disabled, onSelect }: TileProps) {
  const [failed, setFailed] = useState(false);
  // "Auto" tile always renders (no provider arg).
  // Specific-provider tiles hide themselves when the proxy 404s.
  if (provider !== null && failed) return null;

  const src =
    provider === null ? logoCandidates(domain, 256)[0] : logoCandidates(domain, 256, provider)[0];

  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      title={label}
      aria-pressed={selected}
      className={`relative grid aspect-square place-items-center overflow-hidden rounded-md border bg-white p-1.5 transition disabled:opacity-50 ${
        selected ? "border-primary ring-2 ring-primary/40" : "border-border hover:border-primary/60"
      }`}
    >
      <img
        src={src}
        alt={label}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className="h-full w-full object-contain"
      />
      {selected && (
        <span className="absolute right-1 top-1 grid h-4 w-4 place-items-center rounded-full bg-primary text-primary-foreground">
          <Check className="h-3 w-3" />
        </span>
      )}
    </button>
  );
}
