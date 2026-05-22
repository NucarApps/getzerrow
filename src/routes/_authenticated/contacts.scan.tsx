import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { ArrowLeft, Camera, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { scanCard, createContactFromScan } from "@/lib/contacts.functions";
import { sendMyCard } from "@/lib/cards.functions";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/contacts/scan")({
  component: ScanPage,
});

type Draft = {
  name: string | null; title: string | null; company: string | null;
  email: string | null; phone: string | null; website: string | null;
  linkedin: string | null; twitter: string | null;
};

function ScanPage() {
  const navigate = useNavigate();
  const scan = useServerFn(scanCard);
  const create = useServerFn(createContactFromScan);
  const send = useServerFn(sendMyCard);

  const [preview, setPreview] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [scanning, setScanning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sendBack, setSendBack] = useState(true);

  async function onFile(file: File) {
    if (file.size > 8 * 1024 * 1024) {
      toast.error("Image too large (max 8MB)");
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = reader.result as string;
      setPreview(dataUrl);
      setScanning(true);
      try {
        const r = await scan({ data: { imageDataUrl: dataUrl } });
        setDraft(r.draft);
      } catch (e: any) {
        toast.error(e?.message ?? "Couldn't read the card");
      } finally {
        setScanning(false);
      }
    };
    reader.readAsDataURL(file);
  }

  async function save() {
    if (!draft?.email) {
      toast.error("Email is required to save the contact.");
      return;
    }
    setSaving(true);
    try {
      const r = await create({
        data: {
          email: draft.email,
          name: draft.name, title: draft.title, company: draft.company,
          phone: draft.phone, website: draft.website,
          linkedin: draft.linkedin, twitter: draft.twitter,
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
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
        <Link to="/contacts" className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Back
        </Link>

        <h1 className="mb-2 font-display text-2xl text-foreground">Scan a card</h1>
        <p className="mb-6 text-sm text-muted-foreground">
          Take a photo of a paper business card. We'll extract the details with AI — you confirm before saving.
        </p>

        {!preview && (
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

        {preview && (
          <div className="mb-6">
            <img src={preview} alt="Card preview" className="max-h-64 w-full rounded-md border border-border object-contain bg-card/40" />
            <Button variant="ghost" size="sm" className="mt-2" onClick={() => { setPreview(null); setDraft(null); }}>
              Choose a different photo
            </Button>
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
              <DraftField label="Phone" value={draft.phone} onChange={(v) => setDraft({ ...draft, phone: v })} />
              <DraftField label="Website" value={draft.website} onChange={(v) => setDraft({ ...draft, website: v })} />
              <DraftField label="LinkedIn" value={draft.linkedin} onChange={(v) => setDraft({ ...draft, linkedin: v })} />
              <DraftField label="Twitter / X" value={draft.twitter} onChange={(v) => setDraft({ ...draft, twitter: v })} />
            </Grid>

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
