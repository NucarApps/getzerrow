import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Building2,
  Camera,
  Check,
  Loader2,
  Plus,
  Trash2,
  X,
  Merge,
  Sparkles,
  UserPlus,
  Mail,
  CalendarClock,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
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
import { uploadCompanyPhoto, removeCompanyPhoto } from "@/lib/companies/company-photo.functions";
import {
  findCompanyPeopleByDomain,
  addCompanyPeople,
} from "@/lib/companies/company-people.functions";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

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
      nav({ to: "/contacts" });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  if (q.isLoading) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  if (q.error) return <div className="p-6 text-sm text-destructive">Failed to load company.</div>;
  if (!q.data) return null;

  const primaryDomain = q.data.domains[0]?.domain ?? null;
  const tags = q.data.tags.map((t) => t.tag);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-4 py-6">
        <div className="mb-6 flex items-center gap-2">
          <Button variant="ghost" size="sm" asChild>
            <Link to="/contacts">
              <ArrowLeft className="mr-2 h-4 w-4" /> Contacts
            </Link>
          </Button>
        </div>

        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
          <div className="flex min-w-0 flex-1 items-center gap-4">
            <CompanyLogo
              domain={primaryDomain}
              name={form.name}
              size={64}
              photoUrl={(q.data.company as { logo_url?: string | null }).logo_url ?? null}
            />
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

        <Tabs defaultValue="people">
          <TabsList className="mb-4 flex w-full flex-wrap justify-start gap-1">
            <TabsTrigger value="people">People</TabsTrigger>
            <TabsTrigger value="details">Details</TabsTrigger>
            <TabsTrigger value="domains">Domains</TabsTrigger>
            <TabsTrigger value="logo">Logo</TabsTrigger>
            <TabsTrigger value="labels">Labels</TabsTrigger>
          </TabsList>

          <TabsContent value="people">
            <CompanyPeopleFinder companyId={companyId} onAdded={invalidate} />
          </TabsContent>

          <TabsContent value="domains">
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
                      <span className="text-[10px] uppercase text-muted-foreground">
                        {d.source}
                      </span>
                      {d.source === "auto" && d.member_count > 0 && (
                        <span className="text-[10px] text-muted-foreground">
                          · {d.member_count}
                        </span>
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
          </TabsContent>

          <TabsContent value="logo">
            <section className="mb-6 rounded-lg border p-4">
              <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Logo
              </h2>
              <p className="mb-3 text-xs text-muted-foreground">
                Shows for everyone at this company who hasn&apos;t set their own photo. An uploaded
                image wins over the brand logo below.
              </p>
              <CompanyPhotoSection
                companyId={companyId}
                name={form.name}
                primaryDomain={primaryDomain}
                logoUrl={(q.data.company as { logo_url?: string | null }).logo_url ?? null}
              />
              {primaryDomain && (
                <div className="mt-4 border-t pt-4">
                  <p className="mb-3 text-xs text-muted-foreground">Or pick a brand logo:</p>
                  <CompanyLogoPicker
                    primaryDomain={primaryDomain}
                    aliases={q.data.domains.slice(1).map((d) => d.domain)}
                    initialQuery={form.name}
                  />
                </div>
              )}
            </section>
          </TabsContent>

          <TabsContent value="labels">
            <section className="mb-6 rounded-lg border p-4">
              <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Labels
              </h2>
              <p className="mb-3 text-xs text-muted-foreground">
                Labels this company belongs to. Everyone at the company gets them — including
                contacts added later.
              </p>
              <CompanyLabelsSection companyId={companyId} />
            </section>
          </TabsContent>

          <TabsContent value="details">
            <section className="mb-6 grid gap-4 rounded-lg border p-4 sm:grid-cols-2">
              <Labelled label="Website">
                <Input
                  value={form.website}
                  onChange={(e) => setForm({ ...form, website: e.target.value })}
                  placeholder="https://…"
                />
              </Labelled>
              <Labelled label="Phone">
                <Input
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                />
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
                <Input
                  value={form.city}
                  onChange={(e) => setForm({ ...form, city: e.target.value })}
                />
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
                {tags.length === 0 && (
                  <span className="text-sm text-muted-foreground">No tags yet.</span>
                )}
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
          </TabsContent>

          <TabsContent value="people">
            <section className="mb-6 rounded-lg border p-4">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Members ({q.data.members.length})
              </h2>
              {q.data.members.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No contacts link to this company yet.
                </p>
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
          </TabsContent>

          <TabsContent value="details">
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
                      Merge "{form.name || "this company"}" into "{preview.data?.target.name ?? "…"}
                      "?
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
                                    <span className="ml-2 text-xs text-muted-foreground">
                                      {c.email}
                                    </span>
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
          </TabsContent>
        </Tabs>
      </div>
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

const PHOTO_MIME = ["image/jpeg", "image/png", "image/gif", "image/webp"];

/** Upload / remove a custom company photo. It cascades to every member who
 *  hasn't set their own photo (web + iPhone) and wins over the brand logo. */
function CompanyPhotoSection({
  companyId,
  name,
  primaryDomain,
  logoUrl,
}: {
  companyId: string;
  name: string;
  primaryDomain: string | null;
  logoUrl: string | null;
}) {
  const qc = useQueryClient();
  const uploadFn = useServerFn(uploadCompanyPhoto);
  const removeFn = useServerFn(removeCompanyPhoto);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["company", companyId] });
    qc.invalidateQueries({ queryKey: ["companies"] });
    qc.invalidateQueries({ queryKey: ["contacts"] });
  };

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!PHOTO_MIME.includes(file.type)) {
      toast.error("Use JPG, PNG, GIF or WebP");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error("Image too large (max 5 MB)");
      return;
    }
    setBusy(true);
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      let bin = "";
      const chunk = 0x8000;
      for (let i = 0; i < buf.length; i += chunk) {
        bin += String.fromCharCode(...buf.subarray(i, i + chunk));
      }
      await uploadFn({ data: { companyId, base64: btoa(bin), mime: file.type } });
      toast.success("Company photo updated");
      invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async () => {
    setBusy(true);
    try {
      await removeFn({ data: { companyId } });
      toast.success("Company photo removed");
      invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Remove failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-4">
      <CompanyLogo domain={primaryDomain} name={name} size={56} photoUrl={logoUrl} />
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
        >
          {busy ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Camera className="mr-2 h-4 w-4" />
          )}
          {logoUrl ? "Replace photo" : "Upload photo"}
        </Button>
        {logoUrl && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={onRemove}>
            <Trash2 className="mr-2 h-4 w-4" /> Remove
          </Button>
        )}
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/gif,image/webp"
        onChange={onPick}
        hidden
      />
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

/** Find people at this company from the user's email + calendar (matched by
 *  the company's domains, excluding existing contacts) and add+link them. */
function CompanyPeopleFinder({ companyId, onAdded }: { companyId: string; onAdded: () => void }) {
  const findFn = useServerFn(findCompanyPeopleByDomain);
  const addFn = useServerFn(addCompanyPeople);
  const [ran, setRan] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const q = useQuery({
    queryKey: ["company-people", companyId],
    queryFn: () => findFn({ data: { companyId } }),
    enabled: ran,
  });
  const people = q.data?.people ?? [];
  const domains = q.data?.domains ?? [];

  const addMut = useMutation({
    mutationFn: (emails: string[]) => {
      const items = people
        .filter((p) => emails.includes(p.email))
        .map((p) => ({ email: p.email, name: p.name }));
      return addFn({ data: { companyId, items } });
    },
    onSuccess: (res) => {
      toast.success(`Added ${res.added} to this company`);
      setSelected(new Set());
      onAdded();
      q.refetch();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed to add"),
  });

  const toggle = (email: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email);
      else next.add(email);
      return next;
    });

  return (
    <section className="mb-6 rounded-lg border p-4">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Find people from email &amp; calendar
        </h2>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setRan(true);
            if (ran) q.refetch();
          }}
          disabled={q.isFetching}
        >
          {q.isFetching ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Search className="mr-2 h-4 w-4" />
          )}
          {ran ? "Rescan" : "Find people"}
        </Button>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        Scans senders in your mail and your calendar attendees for addresses at this company&apos;s
        domains that aren&apos;t saved yet. Adding links them to the company.
      </p>

      {!ran && (
        <p className="text-sm text-muted-foreground">
          Tap “Find people” to search your email and calendar.
        </p>
      )}
      {ran && !q.isFetching && domains.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Add a domain to this company first so there&apos;s something to match.
        </p>
      )}
      {ran && !q.isFetching && domains.length > 0 && people.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No new people found at {domains.join(", ")}.
        </p>
      )}

      {people.length > 0 && (
        <>
          <div className="mb-2 flex items-center gap-3 text-xs text-muted-foreground">
            <button
              type="button"
              className="underline-offset-2 hover:text-foreground hover:underline"
              onClick={() => setSelected(new Set(people.map((p) => p.email)))}
            >
              Select all ({people.length})
            </button>
            {selected.size > 0 && (
              <button
                type="button"
                className="underline-offset-2 hover:text-foreground hover:underline"
                onClick={() => setSelected(new Set())}
              >
                Clear
              </button>
            )}
          </div>
          <ul className="mb-3 divide-y rounded-md border">
            {people.map((p) => (
              <li key={p.email}>
                <button
                  type="button"
                  onClick={() => toggle(p.email)}
                  className={`flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-muted ${
                    selected.has(p.email) ? "bg-accent/50" : ""
                  }`}
                >
                  <Checkbox checked={selected.has(p.email)} className="pointer-events-none" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{p.name || p.email}</div>
                    {p.name && (
                      <div className="truncate text-xs text-muted-foreground">{p.email}</div>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
                    {p.sources.includes("email") && <Mail className="h-3.5 w-3.5" />}
                    {p.sources.includes("calendar") && <CalendarClock className="h-3.5 w-3.5" />}
                    <span className="text-xs tabular-nums">{p.count}</span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
          <Button
            size="sm"
            disabled={selected.size === 0 || addMut.isPending}
            onClick={() => addMut.mutate([...selected])}
          >
            {addMut.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <UserPlus className="mr-2 h-4 w-4" />
            )}
            Add {selected.size > 0 ? selected.size : ""} to company
          </Button>
        </>
      )}
    </section>
  );
}
