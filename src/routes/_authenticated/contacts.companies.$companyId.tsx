import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ArrowLeft, Building2, Check, Plus, Trash2, X, Merge, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import {
  getCompany,
  updateCompany,
  addCompanyDomain,
  removeCompanyDomain,
  setCompanyTags,
  mergeCompanies,
  previewMergeCompanies,
  deleteCompany,
  listCompanies,
  discoverCompanyDomains,
} from "@/lib/companies/companies.functions";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { CompanyLogo } from "@/components/contacts/CompanyLogo";
import { CompanyLogoPicker } from "@/components/contacts/CompanyLogoPicker";
import { listContactGroups } from "@/lib/contact-groups.functions";
import { listCompanyLabels, setCompanyLabels } from "@/lib/company-groups.functions";

export const Route = createFileRoute("/_authenticated/contacts/companies/$companyId")({
  head: () => ({
    meta: [{ title: "Company — Zerrow" }, { name: "robots", content: "noindex" }],
  }),
  component: CompanyDetailPage,
});

function CompanyDetailPage() {
  const { companyId } = Route.useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const fetchOne = useServerFn(getCompany);
  const fetchList = useServerFn(listCompanies);
  const updateFn = useServerFn(updateCompany);
  const addDomainFn = useServerFn(addCompanyDomain);
  const removeDomainFn = useServerFn(removeCompanyDomain);
  const discoverFn = useServerFn(discoverCompanyDomains);
  const tagsFn = useServerFn(setCompanyTags);
  const mergeFn = useServerFn(mergeCompanies);
  const previewMergeFn = useServerFn(previewMergeCompanies);
  const deleteFn = useServerFn(deleteCompany);

  const q = useQuery({
    queryKey: ["company", companyId],
    queryFn: () => fetchOne({ data: { id: companyId } }),
  });

  const [form, setForm] = useState({
    name: "",
    website: "",
    phone: "",
    address_line1: "",
    address_line2: "",
    city: "",
    region: "",
    postal_code: "",
    country: "",
    industry: "",
    description: "",
  });
  const [tagInput, setTagInput] = useState("");
  const [newDomain, setNewDomain] = useState("");
  const [mergeTargetId, setMergeTargetId] = useState<string>("");
  const [mergePreviewOpen, setMergePreviewOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (q.data?.company) {
      const c = q.data.company;
      setForm({
        name: c.name ?? "",
        website: c.website ?? "",
        phone: c.phone ?? "",
        address_line1: c.address_line1 ?? "",
        address_line2: c.address_line2 ?? "",
        city: c.city ?? "",
        region: c.region ?? "",
        postal_code: c.postal_code ?? "",
        country: c.country ?? "",
        industry: c.industry ?? "",
        description: c.description ?? "",
      });
    }
  }, [q.data?.company]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["company", companyId] });
    qc.invalidateQueries({ queryKey: ["companies"] });
  };

  const saveMut = useMutation({
    mutationFn: () =>
      updateFn({
        data: {
          id: companyId,
          name: form.name || undefined,
          website: form.website || null,
          phone: form.phone || null,
          address_line1: form.address_line1 || null,
          address_line2: form.address_line2 || null,
          city: form.city || null,
          region: form.region || null,
          postal_code: form.postal_code || null,
          country: form.country || null,
          industry: form.industry || null,
          description: form.description || null,
        },
      }),
    onSuccess: () => {
      toast.success("Saved");
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const addDomainMut = useMutation({
    mutationFn: (domain: string) => addDomainFn({ data: { id: companyId, domain } }),
    onSuccess: () => {
      setNewDomain("");
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const removeDomainMut = useMutation({
    mutationFn: (id: string) => removeDomainFn({ data: { id } }),
    onSuccess: () => invalidate(),
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const discoverMut = useMutation({
    mutationFn: () => discoverFn({ data: { id: companyId } }),
    onSuccess: (r) => {
      const parts: string[] = [];
      if (r.added) parts.push(`${r.added} new`);
      if (r.updated) parts.push(`${r.updated} refreshed`);
      toast.success(
        parts.length ? `Discovered domains: ${parts.join(", ")}` : "No new domains found",
      );
      // Refresh both this company detail and the companies list so the logo
      // in every list view updates immediately.
      invalidate();
      qc.invalidateQueries({ queryKey: ["companies"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const tagsMut = useMutation({
    mutationFn: (tags: string[]) => tagsFn({ data: { id: companyId, tags } }),
    onSuccess: () => invalidate(),
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const otherCompanies = useQuery({
    queryKey: ["companies", "merge-candidates"],
    queryFn: () => fetchList(),
  });

  // Only runs when a target is selected AND the confirmation dialog is open.
  // Prevents preloading previews for every dropdown flicker.
  const preview = useQuery({
    queryKey: ["company", companyId, "merge-preview", mergeTargetId],
    queryFn: () => previewMergeFn({ data: { sourceId: companyId, targetId: mergeTargetId } }),
    enabled: mergePreviewOpen && !!mergeTargetId,
    staleTime: 0,
  });

  const mergeMut = useMutation({
    mutationFn: (targetId: string) => mergeFn({ data: { sourceId: companyId, targetId } }),
    onSuccess: (_, targetId) => {
      toast.success("Companies merged");
      qc.invalidateQueries({ queryKey: ["companies"] });
      setMergePreviewOpen(false);
      nav({ to: "/contacts/companies/$companyId", params: { companyId: targetId } });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const deleteMut = useMutation({
    mutationFn: () => deleteFn({ data: { id: companyId } }),
    onSuccess: () => {
      toast.success("Company deleted");
      nav({ to: "/contacts/companies" });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  if (q.isLoading) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  if (q.error) return <div className="p-6 text-sm text-destructive">Failed to load company.</div>;
  if (!q.data) return null;

  const primaryDomain = q.data.domains[0]?.domain ?? null;
  const tags = q.data.tags.map((t) => t.tag);

  return (
    <div className="mx-auto max-w-4xl px-4 py-6">
      <div className="mb-6 flex items-center gap-2">
        <Button variant="ghost" size="sm" asChild>
          <Link to="/contacts/companies">
            <ArrowLeft className="mr-2 h-4 w-4" /> All companies
          </Link>
        </Button>
      </div>

      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-4">
          <CompanyLogo domain={primaryDomain} name={form.name} size={64} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Building2 className="h-4 w-4" /> Company
            </div>
            <Input
              className="mt-1 text-xl font-semibold"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
        </div>
        <Button
          onClick={() => saveMut.mutate()}
          disabled={saveMut.isPending}
          className="self-end sm:self-auto"
        >
          Save
        </Button>
      </div>

      <section className="mb-6 rounded-lg border p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Domains
          </h2>
          <Button
            size="sm"
            variant="outline"
            onClick={() => discoverMut.mutate()}
            disabled={discoverMut.isPending}
          >
            <Sparkles className="mr-2 h-4 w-4" />
            {discoverMut.isPending ? "Scanning members…" : "Discover from members"}
          </Button>
        </div>
        <div className="mb-3 flex flex-wrap gap-2">
          {q.data.domains.length === 0 && (
            <span className="text-sm text-muted-foreground">No domains yet.</span>
          )}
          {q.data.domains.map((d) => {
            const intro = d.discovered_from;
            const introLabel = intro?.name || intro?.email || null;
            return (
              <Badge
                key={d.id}
                variant="secondary"
                className="flex items-center gap-1.5"
                title={
                  introLabel
                    ? `${d.member_count} member${d.member_count === 1 ? "" : "s"} · introduced by ${introLabel}`
                    : `${d.member_count} member${d.member_count === 1 ? "" : "s"}`
                }
              >
                {d.domain}
                <span className="text-[10px] uppercase text-muted-foreground">{d.source}</span>
                {d.source === "auto" && d.member_count > 0 && (
                  <span className="text-[10px] text-muted-foreground">· {d.member_count}</span>
                )}
                {d.source === "auto" && introLabel && (
                  <span className="max-w-[140px] truncate text-[10px] text-muted-foreground">
                    · from {introLabel}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => removeDomainMut.mutate(d.id)}
                  className="ml-1 rounded hover:bg-muted-foreground/20"
                  aria-label={`Remove ${d.domain}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            );
          })}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            placeholder="example.com"
            value={newDomain}
            onChange={(e) => setNewDomain(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newDomain.trim()) {
                addDomainMut.mutate(newDomain.trim());
              }
            }}
          />
          <Button
            variant="outline"
            onClick={() => newDomain.trim() && addDomainMut.mutate(newDomain.trim())}
            disabled={!newDomain.trim() || addDomainMut.isPending}
          >
            <Plus className="mr-2 h-4 w-4" /> Add domain
          </Button>
        </div>
      </section>

      {primaryDomain && (
        <section className="mb-6 rounded-lg border p-4">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Logo
          </h2>
          <CompanyLogoPicker
            primaryDomain={primaryDomain}
            aliases={q.data.domains.slice(1).map((d) => d.domain)}
            initialQuery={form.name}
          />
        </section>
      )}

      <section className="mb-6 rounded-lg border p-4">
        <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Labels
        </h2>
        <p className="mb-3 text-xs text-muted-foreground">
          Labels this company belongs to. Everyone at the company gets them — including contacts
          added later.
        </p>
        <CompanyLabelsSection companyId={companyId} />
      </section>

      <section className="mb-6 grid gap-4 rounded-lg border p-4 sm:grid-cols-2">
        <Labelled label="Website">
          <Input
            value={form.website}
            onChange={(e) => setForm({ ...form, website: e.target.value })}
            placeholder="https://…"
          />
        </Labelled>
        <Labelled label="Phone">
          <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </Labelled>
        <Labelled label="Industry">
          <Input
            value={form.industry}
            onChange={(e) => setForm({ ...form, industry: e.target.value })}
            placeholder="e.g. Automotive"
          />
        </Labelled>
        <Labelled label="Address">
          <Input
            value={form.address_line1}
            onChange={(e) => setForm({ ...form, address_line1: e.target.value })}
            placeholder="Street"
          />
        </Labelled>
        <Labelled label="City">
          <Input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
        </Labelled>
        <Labelled label="State / region">
          <Input
            value={form.region}
            onChange={(e) => setForm({ ...form, region: e.target.value })}
          />
        </Labelled>
        <Labelled label="Postal code">
          <Input
            value={form.postal_code}
            onChange={(e) => setForm({ ...form, postal_code: e.target.value })}
          />
        </Labelled>
        <Labelled label="Country">
          <Input
            value={form.country}
            onChange={(e) => setForm({ ...form, country: e.target.value })}
          />
        </Labelled>
        <div className="sm:col-span-2">
          <Labelled label="Description">
            <Textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              rows={4}
              placeholder="What does this company do?"
            />
          </Labelled>
        </div>
      </section>

      <section className="mb-6 rounded-lg border p-4">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Tags
        </h2>
        <div className="mb-3 flex flex-wrap gap-2">
          {tags.length === 0 && <span className="text-sm text-muted-foreground">No tags yet.</span>}
          {tags.map((t) => (
            <Badge key={t} variant="outline" className="flex items-center gap-1.5">
              {t}
              <button
                type="button"
                onClick={() => tagsMut.mutate(tags.filter((x) => x !== t))}
                aria-label={`Remove ${t}`}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
        <div className="flex gap-2">
          <Input
            placeholder="Add a tag"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && tagInput.trim()) {
                tagsMut.mutate([...tags, tagInput.trim().toLowerCase()]);
                setTagInput("");
              }
            }}
          />
        </div>
      </section>

      <section className="mb-6 rounded-lg border p-4">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Members ({q.data.members.length})
        </h2>
        {q.data.members.length === 0 ? (
          <p className="text-sm text-muted-foreground">No contacts link to this company yet.</p>
        ) : (
          <ul className="divide-y">
            {q.data.members.map((m) => (
              <li key={m.id}>
                <Link
                  to="/contacts/$id"
                  params={{ id: m.id }}
                  className="block px-2 py-2 hover:bg-muted"
                >
                  <div className="text-sm font-medium">{m.name || m.email}</div>
                  <div className="text-xs text-muted-foreground">
                    {[m.title, m.email].filter(Boolean).join(" · ")}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-lg border border-destructive/30 p-4">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Danger zone
        </h2>
        <div className="mb-4 flex flex-col gap-2 sm:flex-row">
          <Select value={mergeTargetId} onValueChange={setMergeTargetId}>
            <SelectTrigger className="w-full sm:max-w-sm">
              <SelectValue placeholder="Merge into another company…" />
            </SelectTrigger>
            <SelectContent>
              {(otherCompanies.data?.companies ?? [])
                .filter((c) => c.id !== companyId)
                .map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            onClick={() => mergeTargetId && setMergePreviewOpen(true)}
            disabled={!mergeTargetId || mergeMut.isPending}
          >
            <Merge className="mr-2 h-4 w-4" /> Preview merge…
          </Button>
        </div>

        <AlertDialog open={mergePreviewOpen} onOpenChange={setMergePreviewOpen}>
          <AlertDialogContent className="w-[calc(100vw-2rem)] max-w-2xl">
            <AlertDialogHeader>
              <AlertDialogTitle>
                Merge "{form.name || "this company"}" into "{preview.data?.target.name ?? "…"}"?
              </AlertDialogTitle>
              <AlertDialogDescription>
                Everything below moves to the target. The source company is then deleted.
              </AlertDialogDescription>
            </AlertDialogHeader>

            <div className="max-h-[50vh] space-y-4 overflow-y-auto text-sm">
              {preview.isLoading && <p className="text-muted-foreground">Loading preview…</p>}
              {preview.error && (
                <p className="text-destructive">
                  {preview.error instanceof Error
                    ? preview.error.message
                    : "Failed to load preview"}
                </p>
              )}
              {preview.data && (
                <>
                  <div>
                    <div className="mb-1 font-medium">
                      Contacts to reassign ({preview.data.contactCount})
                    </div>
                    {preview.data.contacts.length === 0 ? (
                      <p className="text-muted-foreground">No contacts linked.</p>
                    ) : (
                      <ul className="max-h-40 space-y-0.5 overflow-y-auto rounded border p-2">
                        {preview.data.contacts.slice(0, 100).map((c) => (
                          <li key={c.id} className="truncate">
                            {c.name || c.email || "(unnamed)"}
                            {c.name && c.email && (
                              <span className="ml-2 text-xs text-muted-foreground">{c.email}</span>
                            )}
                          </li>
                        ))}
                        {preview.data.contacts.length > 100 && (
                          <li className="text-xs text-muted-foreground">
                            …and {preview.data.contacts.length - 100} more
                          </li>
                        )}
                      </ul>
                    )}
                  </div>

                  <div>
                    <div className="mb-1 font-medium">
                      Domains to move ({preview.data.domains.length})
                    </div>
                    {preview.data.domains.length === 0 ? (
                      <p className="text-muted-foreground">No domains on source.</p>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {preview.data.domains.map((d) => (
                          <Badge
                            key={d.domain}
                            variant={d.conflict ? "outline" : "secondary"}
                            title={
                              d.conflict
                                ? "Target already has this domain — the duplicate will be dropped"
                                : undefined
                            }
                          >
                            {d.domain}
                            {d.conflict && (
                              <span className="ml-1 text-[10px] uppercase text-muted-foreground">
                                dup
                              </span>
                            )}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>

                  {preview.data.tags.length > 0 && (
                    <div>
                      <div className="mb-1 font-medium">
                        Tags to move ({preview.data.tags.length})
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {preview.data.tags.map((t) => (
                          <Badge key={t.tag} variant={t.conflict ? "outline" : "secondary"}>
                            {t.tag}
                            {t.conflict && (
                              <span className="ml-1 text-[10px] uppercase text-muted-foreground">
                                dup
                              </span>
                            )}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            <AlertDialogFooter>
              <AlertDialogCancel disabled={mergeMut.isPending}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={
                  !mergeTargetId || mergeMut.isPending || preview.isLoading || !!preview.error
                }
                onClick={(e) => {
                  e.preventDefault();
                  if (mergeTargetId) mergeMut.mutate(mergeTargetId);
                }}
              >
                <Merge className="mr-2 h-4 w-4" />
                {mergeMut.isPending ? "Merging…" : "Confirm merge"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete “{form.name || "this company"}”?</AlertDialogTitle>
              <AlertDialogDescription>
                Linked contacts keep their data — they just lose the company link.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleteMut.isPending}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={(e) => {
                  e.preventDefault();
                  deleteMut.mutate();
                }}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                {deleteMut.isPending ? "Deleting…" : "Delete company"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <Button
          variant="destructive"
          onClick={() => setConfirmDelete(true)}
          disabled={deleteMut.isPending}
        >
          <Trash2 className="mr-2 h-4 w-4" /> Delete company
        </Button>
      </section>
    </div>
  );
}

function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Label className="mb-1 text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

/** Toggleable label chips backed by company_id group rules — each click
 *  saves immediately and syncs memberships for the whole company. */
function CompanyLabelsSection({ companyId }: { companyId: string }) {
  const qc = useQueryClient();
  const listGroups = useServerFn(listContactGroups);
  const listLabelsFn = useServerFn(listCompanyLabels);
  const setLabelsFn = useServerFn(setCompanyLabels);

  const groupsQ = useQuery({ queryKey: ["contact-groups"], queryFn: () => listGroups() });
  const labelsQ = useQuery({
    queryKey: ["company-labels", companyId],
    queryFn: () => listLabelsFn({ data: { companyId } }),
  });

  const saveMut = useMutation({
    mutationFn: (groupIds: string[]) => setLabelsFn({ data: { companyId, groupIds } }),
    onSuccess: (res) => {
      toast.success(
        res.added + res.removed > 0
          ? `Labels updated — ${res.scanned} contact${res.scanned === 1 ? "" : "s"} synced`
          : "Labels updated",
      );
      qc.invalidateQueries({ queryKey: ["company-labels", companyId] });
      qc.invalidateQueries({ queryKey: ["contact-groups"] });
      qc.invalidateQueries({ queryKey: ["contacts"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const selected = new Set(labelsQ.data?.groupIds ?? []);
  const groups = (groupsQ.data?.groups ?? []).filter((g) => !g.auto_generated_from_group_id);

  if (groupsQ.isLoading || labelsQ.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (groups.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No labels yet — create one from the Contacts page first.
      </p>
    );
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {groups.map((g) => {
        const active = selected.has(g.id);
        return (
          <button
            key={g.id}
            type="button"
            disabled={saveMut.isPending}
            aria-pressed={active}
            onClick={() => {
              const next = new Set(selected);
              if (next.has(g.id)) next.delete(g.id);
              else next.add(g.id);
              saveMut.mutate([...next]);
            }}
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition disabled:opacity-50 ${
              active
                ? "border-primary bg-primary/10 text-foreground"
                : "border-border bg-card/40 text-muted-foreground hover:text-foreground"
            }`}
          >
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: g.color }} />
            <span className="max-w-[12rem] truncate">{g.name}</span>
            {active && <Check className="h-3 w-3" />}
          </button>
        );
      })}
    </div>
  );
}
