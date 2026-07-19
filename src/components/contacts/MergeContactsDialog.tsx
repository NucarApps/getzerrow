// Manual merge of 2–6 contacts into one survivor. User picks the primary
// contact, chooses per-field values, and unions phones/emails/groups.
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  getContactsMergePayload,
  mergeContactsManual,
} from "@/lib/contacts/dedup.functions";

type Props = {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  contactIds: string[];
  onMerged?: (survivorId: string) => void;
};

const SCALAR_FIELDS: Array<{ key: string; label: string }> = [
  { key: "name", label: "Name" },
  { key: "email", label: "Primary email" },
  { key: "title", label: "Title" },
  { key: "company", label: "Company (text)" },
  { key: "company_id", label: "Company (linked)" },
  { key: "avatar_url", label: "Photo" },
  { key: "website", label: "Website" },
  { key: "linkedin", label: "LinkedIn" },
  { key: "twitter", label: "Twitter" },
  { key: "city", label: "City" },
  { key: "region", label: "Region" },
  { key: "postal_code", label: "Postal code" },
  { key: "country", label: "Country" },
];

export function MergeContactsDialog({ open, onOpenChange, contactIds, onMerged }: Props) {
  const qc = useQueryClient();
  const fetchPayload = useServerFn(getContactsMergePayload);
  const doMerge = useServerFn(mergeContactsManual);

  const q = useQuery({
    queryKey: ["contacts-merge-payload", contactIds.slice().sort().join(",")],
    queryFn: () => fetchPayload({ data: { ids: contactIds } }),
    enabled: open && contactIds.length >= 2,
    staleTime: 0,
  });

  const [primaryId, setPrimaryId] = useState<string | null>(null);
  const [fieldChoice, setFieldChoice] = useState<Record<string, string>>({});
  const [notesSource, setNotesSource] = useState<string | null>(null);
  const [keepPhones, setKeepPhones] = useState<Set<string>>(new Set());
  const [keepEmails, setKeepEmails] = useState<Set<string>>(new Set());
  const [primaryPhone, setPrimaryPhone] = useState<string | null>(null);
  const [primaryEmail, setPrimaryEmail] = useState<string | null>(null);
  const [excludedGroups, setExcludedGroups] = useState<Set<string>>(new Set());

  // Seed defaults when payload loads.
  useEffect(() => {
    if (!q.data) return;
    const first = q.data.contacts[0];
    const pid = primaryId ?? first.id;
    setPrimaryId(pid);
    // Best-value default per scalar: prefer the primary's non-empty value,
    // else first non-empty from any contact.
    const nextChoice: Record<string, string> = {};
    for (const f of SCALAR_FIELDS) {
      const primaryVal = (q.data.contacts.find((c) => c.id === pid) as Record<string, unknown>)?.[
        f.key
      ];
      if (primaryVal != null && String(primaryVal).length > 0) {
        nextChoice[f.key] = pid;
        continue;
      }
      const other = q.data.contacts.find(
        (c) => (c as Record<string, unknown>)[f.key] != null &&
          String((c as Record<string, unknown>)[f.key]).length > 0,
      );
      if (other) nextChoice[f.key] = other.id;
    }
    setFieldChoice(nextChoice);
    // Notes: default to whichever contact actually has notes, prefer primary.
    const withNotes = q.data.contacts.find((c) => c.id === pid && c.notes)
      ?? q.data.contacts.find((c) => c.notes);
    setNotesSource(withNotes?.id ?? pid);
    // Keep all phones/emails by default, primary from primary contact.
    setKeepPhones(new Set(q.data.phones.map((p) => p.id)));
    setKeepEmails(new Set(q.data.emails.map((e) => e.id)));
    const pp = q.data.phones.find((p) => p.contact_id === pid && p.is_primary)
      ?? q.data.phones.find((p) => p.contact_id === pid)
      ?? q.data.phones[0];
    setPrimaryPhone(pp?.id ?? null);
    const pe = q.data.emails.find((e) => e.contact_id === pid && e.is_primary)
      ?? q.data.emails.find((e) => e.contact_id === pid)
      ?? q.data.emails[0];
    setPrimaryEmail(pe?.id ?? null);
    setExcludedGroups(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data?.contacts.map((c) => c.id).join(",")]);

  const mut = useMutation({
    mutationFn: async () => {
      if (!primaryId || !q.data) throw new Error("No primary selected");
      const loserIds = q.data.contacts.filter((c) => c.id !== primaryId).map((c) => c.id);
      const fields: Record<string, string | null> = {};
      for (const [fieldKey, sourceId] of Object.entries(fieldChoice)) {
        const src = q.data.contacts.find((c) => c.id === sourceId) as
          | Record<string, unknown>
          | undefined;
        fields[fieldKey] = (src?.[fieldKey] as string | null | undefined) ?? null;
      }
      const emailsPayload = q.data.emails
        .filter((e) => keepEmails.has(e.id))
        .map((e) => ({
          label: e.label,
          address: e.address,
          is_primary: e.id === primaryEmail,
        }));
      const phonesPayload = q.data.phones
        .filter((p) => keepPhones.has(p.id))
        .map((p) => ({
          label: p.label,
          number: p.number,
          is_primary: p.id === primaryPhone,
        }));
      const manualLockFields = Object.keys(fields).filter(
        (k) => fieldChoice[k] && fields[k] != null && String(fields[k]).length > 0,
      );
      return doMerge({
        data: {
          primaryId,
          loserIds,
          fields,
          notesSource: notesSource,
          emails: emailsPayload,
          phones: phonesPayload,
          excludedGroupIds: Array.from(excludedGroups),
          manualLockFields,
        },
      });
    },
    onSuccess: (res) => {
      toast.success(`Merged ${res.deletedCount + 1} contacts into one`);
      qc.invalidateQueries({ queryKey: ["contacts"] });
      qc.invalidateQueries({ queryKey: ["contact"] });
      qc.invalidateQueries({ queryKey: ["contact-duplicates"] });
      onOpenChange(false);
      onMerged?.(res.survivorId);
    },
    onError: (e: unknown) => {
      const msg = e instanceof Error ? e.message : "Merge failed";
      toast.error(msg);
    },
  });

  const groupsById = useMemo(() => {
    const m = new Map<string, { id: string; name: string }>();
    if (q.data) for (const g of q.data.groups) m.set(g.id, g);
    return m;
  }, [q.data]);

  const unionGroupIds = useMemo(() => {
    if (!q.data) return [] as string[];
    return Array.from(new Set(q.data.memberships.map((m) => m.group_id)));
  }, [q.data]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Merge {contactIds.length} contacts</DialogTitle>
        </DialogHeader>

        {q.isLoading || !q.data ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
        ) : (
          <ScrollArea className="max-h-[70vh] pr-3">
            <div className="space-y-6">
              {/* Primary picker */}
              <section>
                <h3 className="mb-2 text-sm font-semibold">Survivor contact</h3>
                <p className="mb-2 text-xs text-muted-foreground">
                  The others are deleted after merging.
                </p>
                <RadioGroup
                  value={primaryId ?? ""}
                  onValueChange={(v) => setPrimaryId(v)}
                  className="grid gap-2"
                >
                  {q.data.contacts.map((c) => (
                    <label
                      key={c.id}
                      className="flex cursor-pointer items-center gap-3 rounded-md border border-border p-2 hover:bg-accent/40"
                    >
                      <RadioGroupItem value={c.id} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{c.name || "Unnamed"}</div>
                        <div className="truncate text-xs text-muted-foreground">
                          {c.email || "—"}
                          {c.company ? ` · ${c.company}` : ""}
                        </div>
                      </div>
                    </label>
                  ))}
                </RadioGroup>
              </section>

              {/* Scalar field picker */}
              <section>
                <h3 className="mb-2 text-sm font-semibold">Fields</h3>
                <div className="grid gap-2">
                  {SCALAR_FIELDS.map((f) => {
                    const opts = q.data.contacts
                      .map((c) => ({
                        id: c.id,
                        name: c.name || c.email || "—",
                        val: (c as Record<string, unknown>)[f.key],
                      }))
                      .filter((o) => o.val != null && String(o.val).length > 0);
                    if (opts.length === 0) return null;
                    // Distinct value check — if all identical, skip.
                    const distinct = new Set(opts.map((o) => String(o.val)));
                    if (distinct.size === 1 && opts.length === q.data.contacts.length) return null;
                    return (
                      <div key={f.key} className="rounded-md border border-border p-2">
                        <div className="mb-1 text-xs font-medium text-muted-foreground">
                          {f.label}
                        </div>
                        <RadioGroup
                          value={fieldChoice[f.key] ?? ""}
                          onValueChange={(v) =>
                            setFieldChoice((s) => ({ ...s, [f.key]: v }))
                          }
                          className="grid gap-1"
                        >
                          {opts.map((o) => (
                            <label
                              key={o.id}
                              className="flex cursor-pointer items-start gap-2 text-sm"
                            >
                              <RadioGroupItem value={o.id} className="mt-1" />
                              <div className="min-w-0 flex-1">
                                <div className="truncate">{String(o.val)}</div>
                                <div className="truncate text-[11px] text-muted-foreground">
                                  from {o.name}
                                </div>
                              </div>
                            </label>
                          ))}
                        </RadioGroup>
                      </div>
                    );
                  })}
                </div>
              </section>

              {/* Notes source */}
              {q.data.contacts.some((c) => c.notes) && (
                <section>
                  <h3 className="mb-2 text-sm font-semibold">Notes</h3>
                  <RadioGroup
                    value={notesSource ?? ""}
                    onValueChange={(v) => setNotesSource(v)}
                    className="grid gap-2"
                  >
                    {q.data.contacts
                      .filter((c) => c.notes)
                      .map((c) => (
                        <label
                          key={c.id}
                          className="flex cursor-pointer items-start gap-2 rounded-md border border-border p-2 text-sm"
                        >
                          <RadioGroupItem value={c.id} className="mt-1" />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-xs text-muted-foreground">
                              from {c.name || c.email}
                            </div>
                            <div className="whitespace-pre-wrap text-sm">{c.notes}</div>
                          </div>
                        </label>
                      ))}
                  </RadioGroup>
                </section>
              )}

              {/* Emails */}
              {q.data.emails.length > 0 && (
                <section>
                  <h3 className="mb-2 text-sm font-semibold">Emails</h3>
                  <div className="grid gap-1">
                    {q.data.emails.map((e) => {
                      const owner = q.data.contacts.find((c) => c.id === e.contact_id);
                      return (
                        <div
                          key={e.id}
                          className="flex items-center gap-2 rounded-md border border-border p-2 text-sm"
                        >
                          <Checkbox
                            checked={keepEmails.has(e.id)}
                            onCheckedChange={(v) =>
                              setKeepEmails((s) => {
                                const n = new Set(s);
                                if (v) n.add(e.id);
                                else n.delete(e.id);
                                return n;
                              })
                            }
                          />
                          <div className="min-w-0 flex-1">
                            <div className="truncate">
                              {e.address}
                              <span className="ml-2 text-xs text-muted-foreground">
                                {e.label}
                              </span>
                            </div>
                            <div className="truncate text-[11px] text-muted-foreground">
                              from {owner?.name || owner?.email}
                            </div>
                          </div>
                          <label className="flex items-center gap-1 text-xs">
                            <input
                              type="radio"
                              name="primaryEmail"
                              checked={primaryEmail === e.id}
                              onChange={() => setPrimaryEmail(e.id)}
                              disabled={!keepEmails.has(e.id)}
                            />
                            Primary
                          </label>
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

              {/* Phones */}
              {q.data.phones.length > 0 && (
                <section>
                  <h3 className="mb-2 text-sm font-semibold">Phones</h3>
                  <div className="grid gap-1">
                    {q.data.phones.map((p) => {
                      const owner = q.data.contacts.find((c) => c.id === p.contact_id);
                      return (
                        <div
                          key={p.id}
                          className="flex items-center gap-2 rounded-md border border-border p-2 text-sm"
                        >
                          <Checkbox
                            checked={keepPhones.has(p.id)}
                            onCheckedChange={(v) =>
                              setKeepPhones((s) => {
                                const n = new Set(s);
                                if (v) n.add(p.id);
                                else n.delete(p.id);
                                return n;
                              })
                            }
                          />
                          <div className="min-w-0 flex-1">
                            <div className="truncate">
                              {p.number}
                              <span className="ml-2 text-xs text-muted-foreground">
                                {p.label}
                              </span>
                            </div>
                            <div className="truncate text-[11px] text-muted-foreground">
                              from {owner?.name || owner?.email}
                            </div>
                          </div>
                          <label className="flex items-center gap-1 text-xs">
                            <input
                              type="radio"
                              name="primaryPhone"
                              checked={primaryPhone === p.id}
                              onChange={() => setPrimaryPhone(p.id)}
                              disabled={!keepPhones.has(p.id)}
                            />
                            Primary
                          </label>
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

              {/* Groups union */}
              {unionGroupIds.length > 0 && (
                <section>
                  <h3 className="mb-2 text-sm font-semibold">Groups</h3>
                  <p className="mb-2 text-xs text-muted-foreground">
                    Uncheck any label you don't want on the survivor.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {unionGroupIds.map((gid) => {
                      const g = groupsById.get(gid);
                      if (!g) return null;
                      const included = !excludedGroups.has(gid);
                      return (
                        <Badge
                          key={gid}
                          variant={included ? "default" : "outline"}
                          className="cursor-pointer"
                          onClick={() =>
                            setExcludedGroups((s) => {
                              const n = new Set(s);
                              if (n.has(gid)) n.delete(gid);
                              else n.add(gid);
                              return n;
                            })
                          }
                        >
                          <Label className="cursor-pointer">{g.name}</Label>
                        </Badge>
                      );
                    })}
                  </div>
                </section>
              )}
            </div>
          </ScrollArea>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={mut.isPending}>
            Cancel
          </Button>
          <Button onClick={() => mut.mutate()} disabled={mut.isPending || !primaryId}>
            {mut.isPending ? "Merging…" : "Merge"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
