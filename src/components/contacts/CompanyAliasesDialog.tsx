import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { X, Plus, Trash2, Check, Star } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import {
  addCompanyAlias, removeCompanyAlias, clearCompanyAliases, promoteAliasToPrimary,
} from "@/lib/company-aliases.functions";
import {
  listCompanyLogoChoices, setCompanyLogoChoice, clearCompanyLogoChoice,
} from "@/lib/company-logo.functions";
import {
  listCompanyGroupAssignments, setCompanyGroups,
} from "@/lib/company-groups.functions";
import { listContactGroups } from "@/lib/contact-groups.functions";
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
  open, onOpenChange, primaryDomain, companyName, aliases, contactIds,
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

  const [newDomain, setNewDomain] = useState("");
  const [busy, setBusy] = useState(false);
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<string>>(new Set());

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
  const savedKey = savedGroupIds.slice().sort().join(",");

  useEffect(() => {
    if (open) setSelectedGroupIds(new Set(savedGroupIds));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, savedKey]);

  useEffect(() => {
    if (!open) setNewDomain("");
  }, [open]);

  if (!primaryDomain) return null;

  function invalidate() {
    qc.invalidateQueries({ queryKey: ["company-aliases"] });
  }

  async function add() {
    const d = newDomain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
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
    if (aliases.length === 0) { onOpenChange(false); return; }
    if (!confirm(`Remove all ${aliases.length} merged ${aliases.length === 1 ? "domain" : "domains"}?`)) return;
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
    [...selectedGroupIds].sort().join(",") !== savedGroupIds.slice().sort().join(",");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <CompanyLogo domain={primaryDomain} name={companyName} size={28} provider={currentChoice} />
            <span className="truncate">{companyName}</span>
          </DialogTitle>
          <DialogDescription>
            Merge multiple email domains under this company and pick which logo to show.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label className="text-xs uppercase tracking-widest text-muted-foreground">Primary domain</Label>
            <div className="mt-1 inline-flex items-center rounded-md border border-border bg-muted/40 px-2.5 py-1 text-sm">
              {primaryDomain}
            </div>
          </div>

          <div>
            <Label className="text-xs uppercase tracking-widest text-muted-foreground">Logo</Label>
            <div className="mt-2 grid grid-cols-4 gap-2">
              <LogoTile
                label="Auto"
                domain={primaryDomain}
                provider={null}
                selected={currentChoice === null}
                disabled={busy}
                onSelect={() => pickLogo(null)}
              />
              {LOGO_PROVIDER_LABELS.map((label, i) => (
                <LogoTile
                  key={i}
                  label={label}
                  domain={primaryDomain}
                  provider={i}
                  selected={currentChoice === i}
                  disabled={busy}
                  onSelect={() => pickLogo(i)}
                />
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Tiles that can't load are hidden. Auto picks the first one that works.
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
                  return (
                    <button
                      key={g.id}
                      type="button"
                      onClick={() => toggleGroup(g.id)}
                      disabled={busy}
                      aria-pressed={active}
                      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition disabled:opacity-50 ${
                        active
                          ? "border-primary bg-primary/10 text-foreground"
                          : "border-border bg-card/40 text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <span
                        className="h-2 w-2 rounded-full"
                        style={{ backgroundColor: g.color }}
                      />
                      <span className="truncate max-w-[10rem]">{g.name}</span>
                      {active && <Check className="h-3 w-3" />}
                    </button>
                  );
                })
              )}
            </div>
            {groups.length > 0 && (
              <div className="mt-2 flex items-center justify-between">
                <p className="text-[11px] text-muted-foreground">
                  Tags apply to everyone in this company.
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
                  <div key={a} className="flex items-center gap-2 rounded-md border border-border bg-card/40 px-2.5 py-1.5 text-sm">
                    <span className="flex-1 truncate">{a}</span>
                    <button
                      onClick={() => remove(a)}
                      disabled={busy}
                      aria-label={`Remove ${a}`}
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
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void add(); } }}
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
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          {aliases.length > 0 && (
            <Button variant="ghost" className="mr-auto text-destructive" onClick={clearAll} disabled={busy}>
              <Trash2 className="mr-1.5 h-4 w-4" /> Delete merge
            </Button>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Close</Button>
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

  const src = provider === null
    ? logoCandidates(domain, 256)[0]
    : logoCandidates(domain, 256, provider)[0];

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
