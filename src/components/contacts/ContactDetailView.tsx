import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";
import {
  Sparkles,
  Send,
  Save,
  Trash2,
  Mail,
  Globe,
  Link2 as Linkedin,
  AtSign as Twitter,
  Building2,
  Plus,
  X,
  Share2,
  MessageSquare,
  MapPin,
  ImageIcon,
  Video,
  Lock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CompanyCombobox } from "@/components/contacts/CompanyCombobox";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  getContact,
  enrichContact,
  updateContact,
  deleteContact,
  shareContactByEmail,
  getContactCardSignedUrl,
  clearContactManualOverrides,
} from "@/lib/contacts.functions";
import { listContactGroups, setContactGroups } from "@/lib/contact-groups.functions";
import { repullContactFromGoogle } from "@/lib/google-contacts.functions";
import { listMeetingsForContact } from "@/lib/meetings.functions";
import { sendMyCard } from "@/lib/cards.functions";
import { listContactRevisions, restoreContactRevision } from "@/lib/contacts/revisions.functions";
import { ContactPhotoUploader } from "@/components/contacts/ContactPhotoUploader";
import { PhonesEditor, type PhoneEntry } from "@/components/contacts/PhonesEditor";
import { EmailsEditor, type EmailEntry } from "@/components/contacts/EmailsEditor";

import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

type Props = {
  id: string;
  onDeleted?: () => void;
};

function errorMessage(e: unknown): string | undefined {
  return e instanceof Error ? e.message : undefined;
}

type ContactQueryData = Awaited<ReturnType<typeof getContact>>;

export function ContactDetailView({ id, onDeleted }: Props) {
  const qc = useQueryClient();
  const fetchOne = useServerFn(getContact);
  const enrich = useServerFn(enrichContact);
  const update = useServerFn(updateContact);
  const del = useServerFn(deleteContact);
  const sendCard = useServerFn(sendMyCard);
  const listGroups = useServerFn(listContactGroups);
  const setGroups = useServerFn(setContactGroups);

  const fetchCardUrl = useServerFn(getContactCardSignedUrl);

  const q = useQuery({ queryKey: ["contact", id], queryFn: () => fetchOne({ data: { id } }) });
  const gq = useQuery({ queryKey: ["contact-groups"], queryFn: () => listGroups() });

  const hasCardImage = Boolean(q.data?.contact?.card_image_url);
  const cardUrlQ = useQuery({
    queryKey: ["contact-card-url", id, q.data?.contact?.card_image_url ?? null],
    queryFn: () => fetchCardUrl({ data: { contactId: id } }),
    enabled: hasCardImage,
    staleTime: 8 * 60 * 1000, // refresh before the 10-minute signed URL expires
  });
  const cardImgSrc = cardUrlQ.data?.url ?? null;

  const myGroupIds = useMemo(() => {
    const ids = new Set<string>();
    for (const m of gq.data?.memberships ?? []) {
      if (m.contact_id === id) ids.add(m.group_id);
    }
    return ids;
  }, [gq.data, id]);

  async function toggleGroup(gid: string) {
    const next = new Set(myGroupIds);
    if (next.has(gid)) next.delete(gid);
    else next.add(gid);
    try {
      await setGroups({ data: { contactId: id, groupIds: [...next] } });
      qc.invalidateQueries({ queryKey: ["contact-groups"] });
    } catch (e: unknown) {
      toast.error(errorMessage(e) ?? "Failed");
    }
  }

  const [form, setForm] = useState({
    name: "",
    title: "",
    company: "",
    email: "",
    website: "",
    linkedin: "",
    twitter: "",
    notes: "",
    address_line1: "",
    address_line2: "",
    city: "",
    region: "",
    postal_code: "",
    country: "",
  });
  const [phones, setPhones] = useState<PhoneEntry[]>([]);
  const [emails, setEmails] = useState<EmailEntry[]>([]);

  const [enriching, setEnriching] = useState(false);
  const [sending, setSending] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [cardImageOpen, setCardImageOpen] = useState(false);

  useEffect(() => {
    if (q.data?.contact) {
      const c = q.data.contact;
      setForm({
        name: c.name ?? "",
        title: c.title ?? "",
        company: c.company ?? "",
        email: c.email ?? "",
        website: c.website ?? "",
        linkedin: c.linkedin ?? "",
        twitter: c.twitter ?? "",
        notes: c.notes ?? "",
        address_line1: c.address_line1 ?? "",
        address_line2: c.address_line2 ?? "",
        city: c.city ?? "",
        region: c.region ?? "",
        postal_code: c.postal_code ?? "",
        country: c.country ?? "",
      });
      const serverPhones = (q.data.phones ?? []) as Array<{
        label: string;
        number: string;
        is_primary: boolean;
      }>;
      if (serverPhones.length > 0) {
        setPhones(
          serverPhones.map((p) => ({
            label: p.label,
            number: p.number,
            is_primary: !!p.is_primary,
          })),
        );
      } else if (c.phone) {
        // Legacy: contact has the old single phone field but no rows in contact_phones yet.
        setPhones([{ label: "mobile", number: c.phone, is_primary: true }]);
      } else {
        setPhones([]);
      }
      const serverEmails = (q.data.emails ?? []) as Array<{
        label: string;
        address: string;
        is_primary: boolean;
      }>;
      if (serverEmails.length > 0) {
        setEmails(
          serverEmails.map((e) => ({
            label: e.label,
            address: e.address,
            is_primary: !!e.is_primary,
          })),
        );
      } else if (c.email) {
        setEmails([{ label: "work", address: c.email, is_primary: true }]);
      } else {
        setEmails([]);
      }
    }

    // Seed local form state when the contact's identity/version changes, keyed
    // on the specific fields below — not on the whole q.data.contact/phones
    // objects, whose refs change on every refetch and would clobber live edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    q.data?.contact?.id,
    q.data?.contact?.enriched_at,
    q.data?.contact?.updated_at,
    q.data?.contact?.name,
    q.data?.contact?.company,
    q.data?.contact?.title,
  ]);

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
      if (r.contact) {
        qc.setQueryData(["contact", id], (prev: ContactQueryData | undefined) => ({
          contact: r.contact,
          recentEmails: prev?.recentEmails ?? [],
          phones: prev?.phones ?? [],
          emails: prev?.emails ?? [],
        }));
      }

      await qc.invalidateQueries({ queryKey: ["contact", id] });
      await qc.invalidateQueries({ queryKey: ["contacts"] });
    } catch (e: unknown) {
      toast.error(errorMessage(e) ?? "Enrich failed");
    } finally {
      setEnriching(false);
    }
  }

  async function save() {
    try {
      // Drop empty phone rows.
      const cleanPhones = phones
        .map((p) => ({ ...p, number: p.number.trim() }))
        .filter((p) => p.number.length > 0);
      const cleanEmails = emails
        .map((e) => ({ ...e, address: e.address.trim().toLowerCase() }))
        .filter((e) => e.address.length > 0);
      // When emails[] is provided, the server derives contacts.email from the
      // primary row — don't also pass the single email field.
      const primaryEmail = cleanEmails.length
        ? (cleanEmails.find((e) => e.is_primary)?.address ?? cleanEmails[0].address)
        : form.email.trim()
          ? form.email.trim()
          : null;
      await update({
        data: {
          id,
          name: form.name || null,
          title: form.title || null,
          company: form.company || null,
          email: primaryEmail,
          website: form.website || null,
          linkedin: form.linkedin || null,
          twitter: form.twitter || null,
          notes: form.notes || null,
          address_line1: form.address_line1 || null,
          address_line2: form.address_line2 || null,
          city: form.city || null,
          region: form.region || null,
          postal_code: form.postal_code || null,
          country: form.country || null,
          phones: cleanPhones,
          emails: cleanEmails,
        },
      });

      toast.success("Saved");
      qc.invalidateQueries({ queryKey: ["contact", id] });
      qc.invalidateQueries({ queryKey: ["contacts"] });
    } catch (e: unknown) {
      toast.error(errorMessage(e) ?? "Save failed");
    }
  }

  async function send() {
    if (!q.data?.contact) return;
    if (!q.data.contact.email) {
      toast.error("Add an email before sending this contact card.");
      return;
    }
    const contactEmail = q.data.contact.email;
    setSending(true);
    try {
      await sendCard({
        data: {
          toEmail: contactEmail,
          contactId: id,
          publicBaseUrl: window.location.origin,
        },
      });
      toast.success(`Card sent to ${contactEmail}`);
    } catch (e: unknown) {
      toast.error(errorMessage(e) ?? "Failed to send card");
    } finally {
      setSending(false);
    }
  }

  async function remove() {
    if (!confirm("Delete this contact?")) return;
    await del({ data: { id } });
    toast.success("Deleted");
    qc.invalidateQueries({ queryKey: ["contacts"] });
    onDeleted?.();
  }

  async function removeCardImage() {
    if (!confirm("Remove the saved card image?")) return;
    try {
      await update({ data: { id, card_image_url: null } });
      qc.invalidateQueries({ queryKey: ["contact", id] });
      toast.success("Card image removed");
    } catch (e: unknown) {
      toast.error(errorMessage(e) ?? "Failed");
    }
  }

  if (q.isLoading) return <div className="p-8 text-sm text-muted-foreground">Loading…</div>;
  if (!q.data?.contact) return <div className="p-8 text-sm text-muted-foreground">Not found.</div>;

  const c = q.data.contact;
  const displayName = c.name || c.email || "Unnamed contact";

  return (
    <div>
      <header className="mb-6 flex items-start gap-4">
        <ContactPhotoUploader
          contactId={c.id}
          avatarUrl={c.avatar_url ?? null}
          displayName={displayName}
          email={c.email ?? null}
          website={c.website ?? null}
          companyDomain={q.data?.companyDomain ?? null}
          companyId={q.data?.companyId ?? null}
          avatarIsCompanyLogoSnapshot={q.data?.avatarIsCompanyLogoSnapshot ?? false}
          onChanged={() => qc.invalidateQueries({ queryKey: ["contact", c.id] })}
        />
        <div className="flex-1 min-w-0">
          <h1 className="font-display text-2xl text-foreground">{displayName}</h1>
          <p className="text-sm text-muted-foreground">
            {c.title || c.company || c.email || "No email"}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            Source: {c.source}
            {c.enriched_at
              ? ` · Enriched ${new Date(c.enriched_at).toLocaleDateString()}`
              : " · Not yet enriched"}
          </p>
        </div>
      </header>

      <div className="mb-6 rounded-lg border border-border bg-muted/30 p-4">
        <div className="mb-2 flex items-center gap-2 text-xs uppercase tracking-widest text-muted-foreground">
          <Sparkles className="h-3.5 w-3.5" /> Relationship summary
        </div>
        {c.relationship_summary ? (
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
            {c.relationship_summary}
          </p>
        ) : enriching ? (
          <p className="text-sm italic text-muted-foreground">
            Reading past emails and writing a briefing…
          </p>
        ) : c.enriched_at ? (
          <p className="text-sm text-muted-foreground">
            Not enough signal in past emails yet. Click Re-enrich to try again.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">No summary yet — click Re-enrich below.</p>
        )}
      </div>

      <div className="mb-6">
        <Label className="mb-2 block text-xs uppercase tracking-widest text-muted-foreground">
          Groups
        </Label>
        <div className="flex flex-wrap items-center gap-1.5">
          {(gq.data?.groups ?? [])
            .filter((g) => myGroupIds.has(g.id))
            .map((g) => (
              <span
                key={g.id}
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card/60 py-0.5 pl-2 pr-1 text-xs"
              >
                <span className="h-2 w-2 rounded-full" style={{ background: g.color }} />
                {g.name}
                <button
                  onClick={() => toggleGroup(g.id)}
                  className="grid h-4 w-4 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                  aria-label={`Remove from ${g.name}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" className="h-7 gap-1 rounded-full px-2.5 text-xs">
                <Plus className="h-3.5 w-3.5" /> Add to group
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
              {(gq.data?.groups ?? []).length === 0 && (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">
                  No groups yet. Create one from the Contacts page.
                </div>
              )}
              {(gq.data?.groups ?? []).map((g) => (
                <DropdownMenuItem key={g.id} onClick={() => toggleGroup(g.id)} className="gap-2">
                  <span className="h-2 w-2 rounded-full" style={{ background: g.color }} />
                  <span className="flex-1">{g.name}</span>
                  {myGroupIds.has(g.id) && <span className="text-xs text-muted-foreground">✓</span>}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => runEnrich(true)}
          disabled={enriching}
          className="flex-1 sm:flex-none"
        >
          <Sparkles className={`mr-2 h-4 w-4 ${enriching ? "animate-pulse" : ""}`} />
          {enriching ? "Reading…" : "Re-enrich"}
        </Button>
        <Button size="sm" onClick={send} disabled={sending} className="flex-1 sm:flex-none">
          <Send className="mr-2 h-4 w-4" /> {sending ? "Sending…" : "Send my card"}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          className="flex-1 sm:flex-none"
          onClick={() => setShareOpen(true)}
        >
          <Share2 className="mr-2 h-4 w-4" /> Share contact
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive w-full sm:w-auto sm:ml-auto"
          onClick={remove}
        >
          <Trash2 className="mr-2 h-4 w-4" /> Delete
        </Button>
      </div>

      <LockedFieldsSection
        contactId={id}
        overrides={(c as { manual_overrides?: string[] | null }).manual_overrides ?? []}
        companyLinked={Boolean(q.data?.companyId)}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" icon={null}>
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Title" icon={null}>
          <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        </Field>
        <Field label="Company" icon={<Building2 className="h-3.5 w-3.5" />}>
          <CompanyCombobox
            value={form.company}
            onChange={(v) => setForm({ ...form, company: v })}
          />
        </Field>
        <Field label="Website" icon={<Globe className="h-3.5 w-3.5" />}>
          <Input
            value={form.website}
            onChange={(e) => setForm({ ...form, website: e.target.value })}
          />
        </Field>
        <Field label="LinkedIn" icon={<Linkedin className="h-3.5 w-3.5" />}>
          <Input
            value={form.linkedin}
            onChange={(e) => setForm({ ...form, linkedin: e.target.value })}
          />
        </Field>
        <Field label="Twitter / X" icon={<Twitter className="h-3.5 w-3.5" />}>
          <Input
            value={form.twitter}
            onChange={(e) => setForm({ ...form, twitter: e.target.value })}
          />
        </Field>
      </div>

      <div className="mt-6">
        <EmailsEditor value={emails} onChange={setEmails} />
        <RepullFromGoogleButton contactId={id} />
      </div>

      <div className="mt-6">
        <PhonesEditor value={phones} onChange={setPhones} />
      </div>

      <div className="mt-6">
        <Label className="mb-2 flex items-center gap-1.5 text-xs uppercase tracking-widest text-muted-foreground">
          <MapPin className="h-3.5 w-3.5" /> Address
        </Label>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Label className="text-xs text-muted-foreground">Address line 1</Label>
            <Input
              value={form.address_line1}
              onChange={(e) => setForm({ ...form, address_line1: e.target.value })}
              placeholder="Street address"
            />
          </div>
          <div className="sm:col-span-2">
            <Label className="text-xs text-muted-foreground">Address line 2</Label>
            <Input
              value={form.address_line2}
              onChange={(e) => setForm({ ...form, address_line2: e.target.value })}
              placeholder="Apt, suite, floor (optional)"
            />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">City</Label>
            <Input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">State / region</Label>
            <Input
              value={form.region}
              onChange={(e) => setForm({ ...form, region: e.target.value })}
            />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Postal code</Label>
            <Input
              value={form.postal_code}
              onChange={(e) => setForm({ ...form, postal_code: e.target.value })}
            />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Country</Label>
            <Input
              value={form.country}
              onChange={(e) => setForm({ ...form, country: e.target.value })}
            />
          </div>
        </div>
      </div>

      {c.card_image_url ? (
        <div className="mt-6">
          <Label className="mb-2 flex items-center gap-1.5 text-xs uppercase tracking-widest text-muted-foreground">
            <ImageIcon className="h-3.5 w-3.5" /> Business card
          </Label>
          <div className="rounded-lg border border-border bg-card/40 p-3">
            <button
              type="button"
              onClick={() => setCardImageOpen(true)}
              className="block w-full overflow-hidden rounded-md"
              aria-label="View card image"
            >
              {cardImgSrc ? (
                <img
                  src={cardImgSrc}
                  alt="Scanned business card"
                  className="max-h-56 w-full object-contain bg-background"
                  loading="lazy"
                />
              ) : (
                <div className="flex h-40 w-full items-center justify-center bg-background text-xs text-muted-foreground">
                  {cardUrlQ.isError ? "Couldn't load card image" : "Loading…"}
                </div>
              )}
            </button>
            <div className="mt-2 flex justify-end">
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive"
                onClick={removeCardImage}
              >
                <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Remove image
              </Button>
            </div>
          </div>
          <Dialog open={cardImageOpen} onOpenChange={setCardImageOpen}>
            <DialogContent className="max-w-3xl">
              <DialogHeader>
                <DialogTitle>Business card</DialogTitle>
                <DialogDescription className="sr-only">
                  Full-size view of the scanned business card.
                </DialogDescription>
              </DialogHeader>
              {cardImgSrc ? (
                <img
                  src={cardImgSrc}
                  alt="Scanned business card"
                  className="w-full rounded-md bg-background object-contain"
                />
              ) : null}
            </DialogContent>
          </Dialog>
        </div>
      ) : null}

      <div className="mt-6">
        <Label className="text-xs text-muted-foreground">Notes</Label>
        <Textarea
          rows={4}
          value={form.notes}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
          placeholder="Private notes about this contact…"
        />
      </div>

      <div className="mt-6 flex justify-end">
        <Button onClick={save}>
          <Save className="mr-2 h-4 w-4" /> Save
        </Button>
      </div>

      {q.data.recentEmails.length > 0 && (
        <section className="mt-10">
          <h2 className="mb-3 text-xs uppercase tracking-widest text-muted-foreground">
            Recent emails
          </h2>
          <ul className="divide-y divide-border rounded-md border border-border bg-card/40">
            {q.data.recentEmails.map((e) => (
              <li key={e.id} className="px-4 py-2 text-sm">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>{e.received_at ? new Date(e.received_at).toLocaleString() : ""}</span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <ContactMeetings contactId={id} />

      <ContactRevisions contactId={id} />

      <ShareContactDialog open={shareOpen} onOpenChange={setShareOpen} contactId={id} contact={c} />
    </div>
  );
}

function ContactMeetings({ contactId }: { contactId: string }) {
  const listFn = useServerFn(listMeetingsForContact);
  const q = useQuery({
    queryKey: ["contact-meetings", contactId],
    queryFn: () => listFn({ data: { contactId } }),
  });
  const meetings = q.data?.meetings ?? [];
  if (meetings.length === 0) return null;
  return (
    <section className="mt-10">
      <h2 className="mb-3 text-xs uppercase tracking-widest text-muted-foreground">Meetings</h2>
      <ul className="divide-y divide-border rounded-md border border-border bg-card/40">
        {meetings.map((m) => (
          <li key={m.id} className="px-4 py-3 text-sm">
            <div className="flex items-center gap-2">
              <Video className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="font-medium">{m.title || "Untitled meeting"}</span>
              <span className="text-xs text-muted-foreground">
                {new Date(m.scheduled_start ?? m.created_at).toLocaleDateString()}
              </span>
            </div>
            {m.summary && (
              <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-xs text-muted-foreground">
                {m.summary}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ShareContactDialog({
  open,
  onOpenChange,
  contactId,
  contact,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  contactId: string;
  contact: {
    name: string | null;
    email: string | null;
    title: string | null;
    company: string | null;
    phone: string | null;
    website: string | null;
  };
}) {
  const share = useServerFn(shareContactByEmail);
  const [toEmail, setToEmail] = useState("");
  const [note, setNote] = useState("");
  const [toPhone, setToPhone] = useState("");
  const [sending, setSending] = useState(false);

  const displayName = contact.name || contact.email || "this contact";
  const smsBody = [
    `${displayName}${contact.title || contact.company ? ` — ${[contact.title, contact.company].filter(Boolean).join(", ")}` : ""}`,
    contact.email ? `Email: ${contact.email}` : "",
    contact.phone ? `Phone: ${contact.phone}` : "",
    contact.website ? contact.website : "",
    "— Shared from Zerrow",
  ]
    .filter(Boolean)
    .join("\n");

  async function sendEmail() {
    setSending(true);
    try {
      await share({ data: { contactId, toEmail, note: note.trim() || undefined } });
      toast.success(`Sent ${displayName}'s info to ${toEmail}`);
      onOpenChange(false);
      setToEmail("");
      setNote("");
    } catch (e: unknown) {
      toast.error(errorMessage(e) ?? "Couldn't send email");
    } finally {
      setSending(false);
    }
  }

  function openMessages() {
    const number = toPhone.replace(/[^\d+]/g, "");
    const href = `sms:${number}${/iPhone|iPad|iPod|Mac/i.test(navigator.userAgent) ? "&" : "?"}body=${encodeURIComponent(smsBody)}`;
    window.location.href = href;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Share {displayName}</DialogTitle>
          <DialogDescription>
            Send their contact details to someone via email or text.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="email" className="mt-2">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="email">
              <Mail className="mr-2 h-4 w-4" /> Email
            </TabsTrigger>
            <TabsTrigger value="sms">
              <MessageSquare className="mr-2 h-4 w-4" /> Text
            </TabsTrigger>
          </TabsList>

          <TabsContent value="email" className="space-y-3 pt-3">
            <div>
              <Label className="mb-1 block text-xs text-muted-foreground">Recipient email</Label>
              <Input
                type="email"
                placeholder="friend@example.com"
                value={toEmail}
                onChange={(e) => setToEmail(e.target.value)}
              />
            </div>
            <div>
              <Label className="mb-1 block text-xs text-muted-foreground">
                Personal note (optional)
              </Label>
              <Textarea
                rows={3}
                placeholder="Thought you two should connect…"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              A .vcf attachment will be included so they can save the contact in one tap.
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={sending}>
                Cancel
              </Button>
              <Button onClick={sendEmail} disabled={sending || !/.+@.+\..+/.test(toEmail)}>
                <Send className="mr-2 h-4 w-4" /> {sending ? "Sending…" : "Send email"}
              </Button>
            </DialogFooter>
          </TabsContent>

          <TabsContent value="sms" className="space-y-3 pt-3">
            <div>
              <Label className="mb-1 block text-xs text-muted-foreground">
                Send to phone number
              </Label>
              <Input
                type="tel"
                placeholder="+1 555 123 4567"
                value={toPhone}
                onChange={(e) => setToPhone(e.target.value)}
              />
            </div>
            <div>
              <Label className="mb-1 block text-xs text-muted-foreground">Message preview</Label>
              <pre className="whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-3 text-xs text-foreground">
                {smsBody}
              </pre>
            </div>
            <p className="text-xs text-muted-foreground">
              Opens your phone's Messages app with the number and text prefilled.
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={openMessages}>
                <MessageSquare className="mr-2 h-4 w-4" /> Open Messages
              </Button>
            </DialogFooter>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  icon,
  children,
}: {
  label: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <Label className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        {label}
      </Label>
      {children}
    </div>
  );
}

function ContactRevisions({ contactId }: { contactId: string }) {
  const qc = useQueryClient();
  const list = useServerFn(listContactRevisions);
  const restore = useServerFn(restoreContactRevision);
  const [busy, setBusy] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["contact-revisions", contactId],
    queryFn: () => list({ data: { contactId } }),
  });

  if (!q.data || q.data.length === 0) return null;

  async function onRestore(id: string) {
    setBusy(id);
    try {
      await restore({ data: { revisionId: id } });
      toast.success("Contact restored");
      qc.invalidateQueries({ queryKey: ["contact", contactId] });
      qc.invalidateQueries({ queryKey: ["contacts"] });
      qc.invalidateQueries({ queryKey: ["contact-revisions", contactId] });
    } catch (e) {
      toast.error(errorMessage(e) ?? "Restore failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="mt-10">
      <h2 className="mb-3 text-xs uppercase tracking-widest text-muted-foreground">History</h2>
      <p className="mb-2 text-xs text-muted-foreground">
        Snapshots taken before syncs from iPhone. Restore if a sync wiped something you'd saved.
      </p>
      <ul className="divide-y divide-border rounded-md border border-border bg-card/40">
        {q.data.map((r) => (
          <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
            <div className="min-w-0">
              <div className="truncate text-xs text-muted-foreground">
                {new Date(r.created_at).toLocaleString()} · {r.source}
              </div>
              <div className="truncate">{r.contact_name ?? r.contact_email ?? "(unnamed)"}</div>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={busy === r.id}
              onClick={() => onRestore(r.id)}
            >
              {busy === r.id ? "Restoring..." : "Restore"}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function RepullFromGoogleButton({ contactId }: { contactId: string }) {
  const qc = useQueryClient();
  const repull = useServerFn(repullContactFromGoogle);
  const [busy, setBusy] = useState(false);
  async function onClick() {
    setBusy(true);
    try {
      const res = await repull({ data: { contactId } });
      if (!res.ok) {
        const reason =
          res.reason === "not_linked"
            ? "This contact isn't linked to a Google contact."
            : res.reason === "not_found_in_google"
              ? "Google no longer has this contact."
              : (res.reason ?? "Re-pull failed");
        toast.error(reason);
        return;
      }
      if (res.emailsAdded || res.phonesAdded) {
        toast.success(
          `Imported ${res.emailsAdded} email${res.emailsAdded === 1 ? "" : "s"}` +
            (res.phonesAdded
              ? ` and ${res.phonesAdded} phone${res.phonesAdded === 1 ? "" : "s"}`
              : "") +
            " from Google",
        );
        qc.invalidateQueries({ queryKey: ["contact", contactId] });
      } else {
        toast.info("Already up to date with Google");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Re-pull failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-2 flex items-center justify-end">
      <Button variant="ghost" size="sm" onClick={onClick} disabled={busy}>
        {busy ? "Re-pulling…" : "Re-pull emails from Google"}
      </Button>
    </div>
  );
}

const LOCKED_FIELD_LABELS: Record<string, string> = {
  name: "Name",
  title: "Title",
  company: "Company",
  phone: "Phone",
  website: "Website",
  linkedin: "LinkedIn",
  twitter: "Twitter",
  notes: "Notes",
  address_line1: "Address line 1",
  address_line2: "Address line 2",
  city: "City",
  region: "Region",
  postal_code: "Postal code",
  country: "Country",
};

type LockedField =
  | "name"
  | "title"
  | "company"
  | "phone"
  | "website"
  | "linkedin"
  | "twitter"
  | "notes"
  | "address_line1"
  | "address_line2"
  | "city"
  | "region"
  | "postal_code"
  | "country";

function LockedFieldsSection({
  contactId,
  overrides,
  companyLinked,
}: {
  contactId: string;
  overrides: string[];
  companyLinked: boolean;
}) {
  const qc = useQueryClient();
  const clearFn = useServerFn(clearContactManualOverrides);
  const [pending, setPending] = useState<string | null>(null);

  const overrideSet = new Set(overrides);
  // Company is implicitly locked whenever a company is linked, even without an
  // override entry — surface that so users understand why enrichment leaves it
  // alone.
  const companyImplicit = companyLinked && !overrideSet.has("company");
  const items: Array<{ field: LockedField | "company"; implicit: boolean }> = [];
  for (const f of Object.keys(LOCKED_FIELD_LABELS) as LockedField[]) {
    if (overrideSet.has(f)) items.push({ field: f, implicit: false });
  }
  if (companyImplicit) items.push({ field: "company", implicit: true });

  async function unlock(field: LockedField) {
    setPending(field);
    try {
      await clearFn({ data: { id: contactId, fields: [field] } });
      toast.success(`${LOCKED_FIELD_LABELS[field]} unlocked`);
      await qc.invalidateQueries({ queryKey: ["contact", contactId] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to unlock");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="mb-6 rounded-md border bg-muted/30 p-3">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium">
        <Lock className="h-3.5 w-3.5" />
        Locked from enrichment
      </div>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No fields are locked. AI enrichment can update any field on this contact.
        </p>
      ) : (
        <>
          <p className="mb-2 text-xs text-muted-foreground">
            These fields were set by you and won't be overwritten by AI enrichment. Click a tag to
            unlock and allow enrichment to fill it again.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {items.map(({ field, implicit }) => {
              const label = LOCKED_FIELD_LABELS[field];
              if (implicit) {
                return (
                  <span
                    key={field}
                    className="inline-flex items-center gap-1 rounded-full border bg-background px-2 py-0.5 text-xs text-muted-foreground"
                    title="Locked because a company is linked. Remove the linked company to unlock."
                  >
                    <Lock className="h-3 w-3" />
                    {label}
                    <span className="text-[10px] uppercase tracking-wide">Linked</span>
                  </span>
                );
              }
              const isPending = pending === field;
              return (
                <button
                  key={field}
                  type="button"
                  disabled={isPending}
                  onClick={() => unlock(field as LockedField)}
                  className="inline-flex items-center gap-1 rounded-full border bg-background px-2 py-0.5 text-xs hover:bg-accent disabled:opacity-50"
                  title="Unlock so AI enrichment can update this field"
                >
                  <Lock className="h-3 w-3" />
                  {label}
                  <X className="h-3 w-3 text-muted-foreground" />
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
