import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { ArrowLeft, Camera, Save, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { scanCard, createContactFromScan } from "@/lib/contacts.functions";
import { sendMyCard } from "@/lib/cards.functions";
import { PhonesEditor, type PhoneEntry } from "@/components/contacts/PhonesEditor";
import { CardCropper } from "@/components/contacts/CardCropper";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/contacts/scan")({
  component: ScanPage,
});

type Draft = {
  name: string | null; title: string | null; company: string | null;
  email: string | null; phone: string | null; website: string | null;
  linkedin: string | null; twitter: string | null;
  address_line1: string | null; address_line2: string | null;
  city: string | null; region: string | null;
  postal_code: string | null; country: string | null;
};

function ScanPage() {
  const navigate = useNavigate();
  const scan = useServerFn(scanCard);
  const create = useServerFn(createContactFromScan);
  const send = useServerFn(sendMyCard);

  /** Raw file as data URL, shown in the cropper. */
  const [raw, setRaw] = useState<string | null>(null);
  /** Cropped card image (preview + AI input). */
  const [cropped, setCropped] = useState<string | null>(null);
  const [cardImageUrl, setCardImageUrl] = useState<string | null>(null);
  const [uploadingCard, setUploadingCard] = useState(false);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [phones, setPhones] = useState<PhoneEntry[]>([]);
  const [scanning, setScanning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sendBack, setSendBack] = useState(true);

  function resetAll() {
    setRaw(null);
    setCropped(null);
    setCardImageUrl(null);
    setDraft(null);
    setPhones([]);
  }

  function onFile(file: File) {
    if (file.size > 8 * 1024 * 1024) {
      toast.error("Image too large (max 8MB)");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      resetAll();
      setRaw(reader.result as string);
    };
    reader.readAsDataURL(file);
  }

  async function onCropConfirm(out: { dataUrl: string; blob: Blob }) {
    setCropped(out.dataUrl);
    setRaw(null);

    // Kick off upload + AI scan in parallel.
    setUploadingCard(true);
    setScanning(true);

    const uploadP = (async () => {
      try {
        const { data: userData } = await supabase.auth.getUser();
        const uid = userData.user?.id;
        if (!uid) return;
        const path = `${uid}/${crypto.randomUUID()}.jpg`;
        const { error } = await supabase.storage
          .from("card-images")
          .upload(path, out.blob, { contentType: "image/jpeg", upsert: false });
        if (error) throw error;
        const { data: pub } = supabase.storage.from("card-images").getPublicUrl(path);
        setCardImageUrl(pub.publicUrl);
      } catch (e: any) {
        toast.warning(`Couldn't save card image: ${e?.message ?? "unknown"}`);
      } finally {
        setUploadingCard(false);
      }
    })();

    const scanP = (async () => {
      try {
        const r = await scan({ data: { imageDataUrl: out.dataUrl } });
        const d = r.draft as Partial<Draft> & { phones?: Array<{ label: string; number: string }> | null };
        setDraft({
          name: d.name ?? null, title: d.title ?? null, company: d.company ?? null,
          email: d.email ?? null, phone: d.phone ?? null, website: d.website ?? null,
          linkedin: d.linkedin ?? null, twitter: d.twitter ?? null,
          address_line1: d.address_line1 ?? null, address_line2: d.address_line2 ?? null,
          city: d.city ?? null, region: d.region ?? null,
          postal_code: d.postal_code ?? null, country: d.country ?? null,
        });
        const aiPhones = (d.phones ?? []).filter((p) => p?.number?.trim());
        const initial: PhoneEntry[] = aiPhones.length > 0
          ? aiPhones.map((p, i) => ({ label: (p.label || "mobile").toLowerCase(), number: p.number, is_primary: i === 0 }))
          : (d.phone ? [{ label: "mobile", number: d.phone, is_primary: true }] : []);
        setPhones(initial);
      } catch (e: any) {
        toast.error(e?.message ?? "Couldn't read the card");
      } finally {
        setScanning(false);
      }
    })();

    await Promise.allSettled([uploadP, scanP]);
  }

  async function save() {
    if (!draft?.email) {
      toast.error("Email is required to save the contact.");
      return;
    }
    setSaving(true);
    try {
      const cleanPhones = phones
        .map((p) => ({ ...p, number: p.number.trim() }))
        .filter((p) => p.number.length > 0);
      const r = await create({
        data: {
          email: draft.email,
          name: draft.name, title: draft.title, company: draft.company,
          phone: draft.phone, website: draft.website,
          linkedin: draft.linkedin, twitter: draft.twitter,
          address_line1: draft.address_line1, address_line2: draft.address_line2,
          city: draft.city, region: draft.region,
          postal_code: draft.postal_code, country: draft.country,
          card_image_url: cardImageUrl,
          phones: cleanPhones,
        },
      });
      if (sendBack) {
        try {
          await send({ data: { toEmail: draft.email, contactId: r.contact.id, publicBaseUrl: window.location.origin } });
          toast.success(`Saved & sent your card to ${draft.email}`);
        } catch (e: any) {
          toast.warning(`Saved, but couldn't send your card: ${e?.message ?? "unknown"}`);
        }
      } else {
        toast.success("Contact saved");
      }
      navigate({ to: "/contacts/$id", params: { id: r.contact.id } });
    } catch (e: any) {
      toast.error(e?.message ?? "Save failed");
    } finally {
      setSaving(false);
    }
    // Silence unused-var warning for croppedBlob (kept in state for potential re-upload).
    void croppedBlob;
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
        <Link to="/contacts" className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Back
        </Link>

        <h1 className="mb-2 font-display text-2xl text-foreground">Scan a card</h1>
        <p className="mb-6 text-sm text-muted-foreground">
          Take a photo of a paper business card. We'll auto-crop and extract the details — you confirm before saving.
        </p>

        {!raw && !cropped && (
          <label className="flex cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed border-border bg-card/40 px-6 py-16 text-center transition hover:border-primary/50">
            <Camera className="h-10 w-10 text-muted-foreground" />
            <span className="text-sm font-medium text-foreground">Tap to take a photo or choose an image</span>
            <span className="text-xs text-muted-foreground">JPG or PNG, up to 8MB</span>
            <input
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }}
            />
          </label>
        )}

        {raw && !cropped && (
          <div className="mb-6">
            <h2 className="mb-3 text-sm font-medium text-foreground">Crop to just the card</h2>
            <CardCropper src={raw} onConfirm={onCropConfirm} onCancel={resetAll} />
          </div>
        )}

        {cropped && (
          <div className="mb-6">
            <img src={cropped} alt="Cropped card" className="max-h-64 w-full rounded-md border border-border object-contain bg-card/40" />
            <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
              {uploadingCard && <span>Saving image…</span>}
              {!uploadingCard && cardImageUrl && <span>Image saved</span>}
              <Button variant="ghost" size="sm" onClick={resetAll}>
                Choose a different photo
              </Button>
            </div>
          </div>
        )}

        {scanning && (
          <p className="text-sm text-muted-foreground">Reading card…</p>
        )}

        {draft && !scanning && (
          <div className="space-y-4">
            <h2 className="text-sm font-medium text-foreground">Confirm details</h2>
            <Grid>
              <DraftField label="Name" value={draft.name} onChange={(v) => setDraft({ ...draft, name: v })} />
              <DraftField label="Title" value={draft.title} onChange={(v) => setDraft({ ...draft, title: v })} />
              <DraftField label="Company" value={draft.company} onChange={(v) => setDraft({ ...draft, company: v })} />
              <DraftField label="Email *" value={draft.email} onChange={(v) => setDraft({ ...draft, email: v })} />
              <DraftField label="Website" value={draft.website} onChange={(v) => setDraft({ ...draft, website: v })} />
              <DraftField label="LinkedIn" value={draft.linkedin} onChange={(v) => setDraft({ ...draft, linkedin: v })} />
              <DraftField label="Twitter / X" value={draft.twitter} onChange={(v) => setDraft({ ...draft, twitter: v })} />
            </Grid>

            <PhonesEditor value={phones} onChange={setPhones} />

            <div>
              <Label className="mb-2 flex items-center gap-1.5 text-xs uppercase tracking-widest text-muted-foreground">
                <MapPin className="h-3.5 w-3.5" /> Address
              </Label>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <DraftField label="Address line 1" value={draft.address_line1} onChange={(v) => setDraft({ ...draft, address_line1: v })} />
                </div>
                <div className="sm:col-span-2">
                  <DraftField label="Address line 2" value={draft.address_line2} onChange={(v) => setDraft({ ...draft, address_line2: v })} />
                </div>
                <DraftField label="City" value={draft.city} onChange={(v) => setDraft({ ...draft, city: v })} />
                <DraftField label="State / region" value={draft.region} onChange={(v) => setDraft({ ...draft, region: v })} />
                <DraftField label="Postal code" value={draft.postal_code} onChange={(v) => setDraft({ ...draft, postal_code: v })} />
                <DraftField label="Country" value={draft.country} onChange={(v) => setDraft({ ...draft, country: v })} />
              </div>
            </div>

            <label className="flex items-center gap-2 text-sm text-foreground">
              <Checkbox checked={sendBack} onCheckedChange={(v) => setSendBack(!!v)} />
              Email my card back to them
            </label>

            <Button onClick={save} disabled={saving} className="w-full sm:w-auto">
              <Save className="mr-2 h-4 w-4" /> {saving ? "Saving…" : "Save contact"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-3 sm:grid-cols-2">{children}</div>;
}

function DraftField({ label, value, onChange }: { label: string; value: string | null; onChange: (v: string) => void }) {
  return (
    <div>
      <Label className="mb-1 block text-xs text-muted-foreground">{label}</Label>
      <Input value={value ?? ""} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
