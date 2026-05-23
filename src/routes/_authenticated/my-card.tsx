import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { ArrowLeft, Save, ExternalLink, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { getMyCard, upsertMyCard } from "@/lib/cards.functions";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { ImageCropUpload } from "@/components/cards/ImageCropUpload";
import { ThemePicker } from "@/components/cards/themes";

export const Route = createFileRoute("/_authenticated/my-card")({
  head: () => ({ meta: [{ title: "My Card — Zerrow" }] }),
  component: MyCardPage,
});

function MyCardPage() {
  const qc = useQueryClient();
  const fetchCard = useServerFn(getMyCard);
  const save = useServerFn(upsertMyCard);
  const q = useQuery({ queryKey: ["my-card"], queryFn: () => fetchCard() });

  const [userId, setUserId] = useState<string | null>(null);
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUserId(data.user?.id ?? null));
  }, []);

  const [form, setForm] = useState({
    handle: "", name: "", title: "", company: "", email: "", phone: "",
    website: "", linkedin: "", twitter: "", tagline: "",
    avatar_url: "" as string | "",
    cover_url: "" as string | "",
    theme: "default",
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (q.data?.card) {
      const c: any = q.data.card;
      setForm({
        handle: c.handle ?? "", name: c.name ?? "", title: c.title ?? "",
        company: c.company ?? "", email: c.email ?? "", phone: c.phone ?? "",
        website: c.website ?? "", linkedin: c.linkedin ?? "",
        twitter: c.twitter ?? "", tagline: c.tagline ?? "",
        avatar_url: c.avatar_url ?? "", cover_url: c.cover_url ?? "",
        theme: c.theme ?? "default",
      });
    }
  }, [q.data?.card?.handle]);

  async function onSave() {
    setSaving(true);
    try {
      await save({
        data: {
          handle: form.handle.toLowerCase(),
          name: form.name || null, title: form.title || null,
          company: form.company || null, email: form.email || null,
          phone: form.phone || null, website: form.website || null,
          linkedin: form.linkedin || null, twitter: form.twitter || null,
          tagline: form.tagline || null,
          avatar_url: form.avatar_url || null,
          cover_url: form.cover_url || null,
          theme: form.theme || "default",
        },
      });
      toast.success("Card saved");
      qc.invalidateQueries({ queryKey: ["my-card"] });
    } catch (e: any) {
      toast.error(e?.message ?? "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const publicUrl = form.handle && typeof window !== "undefined"
    ? `${window.location.origin}/c/${form.handle.toLowerCase()}`
    : "";

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <Link to="/contacts" className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Back to contacts
        </Link>

        <h1 className="mb-2 font-display text-2xl text-foreground">My business card</h1>
        <p className="mb-6 text-sm text-muted-foreground">
          This is what people see when you share your link or QR. Choose a handle — your card lives at <code className="text-foreground">/c/your-handle</code>.
        </p>

        {/* Images */}
        {userId && (
          <div className="mb-6 space-y-4 rounded-lg border border-border bg-card/40 p-4">
            <div>
              <Label className="mb-2 block text-xs text-muted-foreground">Cover image (3:1)</Label>
              <ImageCropUpload
                userId={userId}
                kind="cover"
                value={form.cover_url || null}
                onChange={(url) => setForm({ ...form, cover_url: url ?? "" })}
                aspect={3 / 1}
                shape="rect"
              />
            </div>
            <div>
              <Label className="mb-2 block text-xs text-muted-foreground">Photo</Label>
              <ImageCropUpload
                userId={userId}
                kind="avatar"
                value={form.avatar_url || null}
                onChange={(url) => setForm({ ...form, avatar_url: url ?? "" })}
                aspect={1}
                shape="circle"
                outputSize={512}
              />
            </div>
          </div>
        )}

        {/* Theme */}
        <div className="mb-6 rounded-lg border border-border bg-card/40 p-4">
          <Label className="mb-3 block text-xs text-muted-foreground">Theme</Label>
          <ThemePicker value={form.theme} onChange={(id) => setForm({ ...form, theme: id })} />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Handle (URL)">
            <Input value={form.handle} onChange={(e) => setForm({ ...form, handle: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") })} placeholder="jane-doe" />
          </Field>
          <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Title"><Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
          <Field label="Company"><Input value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} /></Field>
          <Field label="Email"><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Phone"><Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
          <Field label="Website"><Input value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} /></Field>
          <Field label="LinkedIn"><Input value={form.linkedin} onChange={(e) => setForm({ ...form, linkedin: e.target.value })} /></Field>
          <Field label="Twitter / X"><Input value={form.twitter} onChange={(e) => setForm({ ...form, twitter: e.target.value })} /></Field>
        </div>

        <div className="mt-4">
          <Label className="mb-1 block text-xs text-muted-foreground">Tagline</Label>
          <Textarea rows={2} value={form.tagline} onChange={(e) => setForm({ ...form, tagline: e.target.value })} placeholder="A short pitch or status…" />
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Button onClick={onSave} disabled={saving || !form.handle}>
            <Save className="mr-2 h-4 w-4" /> {saving ? "Saving…" : "Save card"}
          </Button>
          {q.data?.card && publicUrl && (
            <>
              <Button variant="outline" asChild>
                <a href={publicUrl} target="_blank" rel="noreferrer">
                  <ExternalLink className="mr-2 h-4 w-4" /> View public card
                </a>
              </Button>
              <Button variant="ghost" onClick={() => { navigator.clipboard.writeText(publicUrl); toast.success("Link copied"); }}>
                <Copy className="mr-2 h-4 w-4" /> Copy link
              </Button>
            </>
          )}
        </div>

        {q.data?.card && publicUrl && (
          <div className="mt-8 flex flex-col items-center gap-3 rounded-lg border border-border bg-card/40 p-6">
            <h2 className="text-sm font-medium text-foreground">Your QR code</h2>
            <div className="rounded-md bg-white p-3">
              <QRCodeSVG value={publicUrl} size={180} />
            </div>
            <code className="text-xs text-muted-foreground">{publicUrl}</code>
          </div>
        )}
      </div>
    </div>
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
