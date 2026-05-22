import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Sparkles, Send, Save, Trash2, Mail, Phone, Globe, Linkedin, Twitter, Building2, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { getContact, enrichContact, updateContact, deleteContact } from "@/lib/contacts.functions";
import { listContactGroups, setContactGroups } from "@/lib/contact-groups.functions";
import { sendMyCard } from "@/lib/cards.functions";
import { toast } from "sonner";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export const Route = createFileRoute("/_authenticated/contacts/$id")({
  component: ContactDetail,
});

function ContactDetail() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const fetchOne = useServerFn(getContact);
  const enrich = useServerFn(enrichContact);
  const update = useServerFn(updateContact);
  const del = useServerFn(deleteContact);
  const sendCard = useServerFn(sendMyCard);
  const listGroups = useServerFn(listContactGroups);
  const setGroups = useServerFn(setContactGroups);

  const q = useQuery({ queryKey: ["contact", id], queryFn: () => fetchOne({ data: { id } }) });
  const gq = useQuery({ queryKey: ["contact-groups"], queryFn: () => listGroups() });

  const myGroupIds = useMemo(() => {
    const ids = new Set<string>();
    for (const m of gq.data?.memberships ?? []) {
      if (m.contact_id === id) ids.add(m.group_id);
    }
    return ids;
  }, [gq.data, id]);

  async function toggleGroup(gid: string) {
    const next = new Set(myGroupIds);
    if (next.has(gid)) next.delete(gid); else next.add(gid);
    try {
      await setGroups({ data: { contactId: id, groupIds: [...next] } });
      qc.invalidateQueries({ queryKey: ["contact-groups"] });
    } catch (e: any) {
      toast.error(e?.message ?? "Failed");
    }
  }

  const [form, setForm] = useState({
    name: "", title: "", company: "", phone: "",
    website: "", linkedin: "", twitter: "", notes: "",
  });
  const [enriching, setEnriching] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (q.data?.contact) {
      const c = q.data.contact;
      setForm({
        name: c.name ?? "", title: c.title ?? "", company: c.company ?? "",
        phone: c.phone ?? "", website: c.website ?? "", linkedin: c.linkedin ?? "",
        twitter: c.twitter ?? "", notes: c.notes ?? "",
      });
    }
  }, [q.data?.contact?.id]);

  // Auto-enrich on first visit if never enriched.
  useEffect(() => {
    const c = q.data?.contact;
    if (c && !c.enriched_at && !enriching && c.source === "email") {
      runEnrich();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data?.contact?.id]);

  async function runEnrich(force = false) {
    setEnriching(true);
    try {
      const r = await enrich({ data: { id, force } });
      if (r.skipped) toast.info("Already enriched recently");
      else toast.success("Enriched from email signatures");
      qc.invalidateQueries({ queryKey: ["contact", id] });
    } catch (e: any) {
      toast.error(e?.message ?? "Enrich failed");
    } finally {
      setEnriching(false);
    }
  }

  async function save() {
    try {
      await update({
        data: {
          id,
          name: form.name || null,
          title: form.title || null,
          company: form.company || null,
          phone: form.phone || null,
          website: form.website || null,
          linkedin: form.linkedin || null,
          twitter: form.twitter || null,
          notes: form.notes || null,
        },
      });
      toast.success("Saved");
      qc.invalidateQueries({ queryKey: ["contact", id] });
      qc.invalidateQueries({ queryKey: ["contacts"] });
    } catch (e: any) {
      toast.error(e?.message ?? "Save failed");
    }
  }

  async function send() {
    if (!q.data?.contact) return;
    setSending(true);
    try {
      await sendCard({
        data: {
          toEmail: q.data.contact.email,
          contactId: id,
          publicBaseUrl: window.location.origin,
        },
      });
      toast.success(`Card sent to ${q.data.contact.email}`);
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to send card");
    } finally {
      setSending(false);
    }
  }

  async function remove() {
    if (!confirm("Delete this contact?")) return;
    await del({ data: { id } });
    toast.success("Deleted");
    navigate({ to: "/contacts" });
  }

  if (q.isLoading) return <div className="p-8 text-sm text-muted-foreground">Loading…</div>;
  if (!q.data?.contact) return <div className="p-8 text-sm text-muted-foreground">Not found.</div>;

  const c = q.data.contact;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <Link to="/contacts" className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Back
        </Link>

        <header className="mb-6 flex items-start gap-4">
          <div className="grid h-16 w-16 shrink-0 place-items-center rounded-full bg-primary/15 text-2xl font-semibold text-primary">
            {(c.name || c.email).slice(0, 1).toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="font-display text-2xl text-foreground">{c.name || c.email}</h1>
            <p className="text-sm text-muted-foreground">{c.title || c.company || c.email}</p>
            <p className="text-xs text-muted-foreground mt-1">
              Source: {c.source}
              {c.enriched_at ? ` · Enriched ${new Date(c.enriched_at).toLocaleDateString()}` : " · Not yet enriched"}
            </p>
          </div>
        </header>

        <div className="mb-6 flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => runEnrich(true)} disabled={enriching}>
            <Sparkles className={`mr-2 h-4 w-4 ${enriching ? "animate-pulse" : ""}`} />
            {enriching ? "Reading signatures…" : "Re-enrich with AI"}
          </Button>
          <Button size="sm" onClick={send} disabled={sending}>
            <Send className="mr-2 h-4 w-4" /> {sending ? "Sending…" : "Send my card"}
          </Button>
          <Button size="sm" variant="ghost" className="text-destructive ml-auto" onClick={remove}>
            <Trash2 className="mr-2 h-4 w-4" /> Delete
          </Button>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" icon={null}>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Title" icon={null}>
            <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </Field>
          <Field label="Company" icon={<Building2 className="h-3.5 w-3.5" />}>
            <Input value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} />
          </Field>
          <Field label="Email" icon={<Mail className="h-3.5 w-3.5" />}>
            <Input value={c.email} disabled />
          </Field>
          <Field label="Phone" icon={<Phone className="h-3.5 w-3.5" />}>
            <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </Field>
          <Field label="Website" icon={<Globe className="h-3.5 w-3.5" />}>
            <Input value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} />
          </Field>
          <Field label="LinkedIn" icon={<Linkedin className="h-3.5 w-3.5" />}>
            <Input value={form.linkedin} onChange={(e) => setForm({ ...form, linkedin: e.target.value })} />
          </Field>
          <Field label="Twitter / X" icon={<Twitter className="h-3.5 w-3.5" />}>
            <Input value={form.twitter} onChange={(e) => setForm({ ...form, twitter: e.target.value })} />
          </Field>
        </div>

        <div className="mt-4">
          <Label className="text-xs text-muted-foreground">Notes</Label>
          <Textarea
            rows={4}
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
            placeholder="Private notes about this contact…"
          />
        </div>

        <div className="mt-6 flex justify-end">
          <Button onClick={save}><Save className="mr-2 h-4 w-4" /> Save</Button>
        </div>

        {q.data.recentEmails.length > 0 && (
          <section className="mt-10">
            <h2 className="mb-3 text-xs uppercase tracking-widest text-muted-foreground">Recent emails</h2>
            <ul className="divide-y divide-border rounded-md border border-border bg-card/40">
              {q.data.recentEmails.map((e) => (
                <li key={e.id} className="px-4 py-2 text-sm">
                  <div className="truncate font-medium text-foreground">{e.subject || "(no subject)"}</div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{e.received_at ? new Date(e.received_at).toLocaleString() : ""}</span>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

function Field({ label, icon, children }: { label: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <Label className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">{icon}{label}</Label>
      {children}
    </div>
  );
}
