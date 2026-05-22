import { createFileRoute, notFound } from "@tanstack/react-router";
import { QRCodeSVG } from "qrcode.react";
import { Mail, Phone, Globe, Linkedin, Twitter, Building2, Download } from "lucide-react";
import { getPublicCard, getPublicVCard } from "@/lib/cards.functions";

export const Route = createFileRoute("/c/$handle")({
  loader: async ({ params }) => {
    const r = await getPublicCard({ data: { handle: params.handle } });
    if (!r.card) throw notFound();
    return r;
  },
  head: ({ loaderData }) => ({
    meta: loaderData?.card
      ? [
          { title: `${loaderData.card.name || loaderData.card.handle} — Contact card` },
          { name: "description", content: loaderData.card.tagline || `${loaderData.card.name || ""} ${loaderData.card.title ? "· " + loaderData.card.title : ""}`.trim() },
        ]
      : [{ title: "Card not found" }],
  }),
  notFoundComponent: () => (
    <div className="min-h-screen grid place-items-center bg-background text-foreground">
      <p className="text-sm text-muted-foreground">No card at this link.</p>
    </div>
  ),
  errorComponent: () => (
    <div className="min-h-screen grid place-items-center bg-background text-foreground">
      <p className="text-sm text-destructive">Something went wrong loading this card.</p>
    </div>
  ),
  component: PublicCard,
});

function PublicCard() {
  const { card } = Route.useLoaderData();
  if (!card) return null;
  const publicUrl = typeof window !== "undefined" ? window.location.href : "";

  async function download() {
    const r = await getPublicVCard({ data: { handle: card!.handle, publicUrl } });
    const blob = new Blob([r.vcard], { type: "text/vcard" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${card!.name || card!.handle}.vcf`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-background via-background to-card text-foreground">
      <div className="mx-auto max-w-md px-4 py-12">
        <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
          <div className="h-24 bg-gradient-to-br from-primary to-primary/40" />
          <div className="px-6 pb-6 -mt-12">
            <div className="grid h-24 w-24 place-items-center rounded-full border-4 border-card bg-primary/30 text-3xl font-semibold text-primary-foreground">
              {(card.name || card.handle).slice(0, 1).toUpperCase()}
            </div>
            <h1 className="mt-4 font-display text-2xl text-foreground">{card.name || card.handle}</h1>
            {card.title && <p className="text-sm text-muted-foreground">{card.title}</p>}
            {card.tagline && <p className="mt-3 text-sm italic text-foreground/80">"{card.tagline}"</p>}

            <ul className="mt-6 space-y-2 text-sm">
              {card.company && <Row icon={<Building2 className="h-4 w-4" />}>{card.company}</Row>}
              {card.email && <Row icon={<Mail className="h-4 w-4" />}><a href={`mailto:${card.email}`} className="hover:underline">{card.email}</a></Row>}
              {card.phone && <Row icon={<Phone className="h-4 w-4" />}><a href={`tel:${card.phone}`} className="hover:underline">{card.phone}</a></Row>}
              {card.website && <Row icon={<Globe className="h-4 w-4" />}><a href={card.website} target="_blank" rel="noreferrer" className="hover:underline">{card.website}</a></Row>}
              {card.linkedin && <Row icon={<Linkedin className="h-4 w-4" />}><a href={card.linkedin} target="_blank" rel="noreferrer" className="hover:underline">LinkedIn</a></Row>}
              {card.twitter && <Row icon={<Twitter className="h-4 w-4" />}><a href={card.twitter} target="_blank" rel="noreferrer" className="hover:underline">Twitter / X</a></Row>}
            </ul>

            <button
              onClick={download}
              className="mt-6 flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              <Download className="h-4 w-4" /> Save to contacts (.vcf)
            </button>

            <div className="mt-6 flex flex-col items-center gap-2">
              <div className="rounded-md bg-white p-2">
                <QRCodeSVG value={publicUrl} size={120} />
              </div>
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground">Scan to share</p>
            </div>
          </div>
        </div>
        <p className="mt-6 text-center text-xs text-muted-foreground">
          Powered by <a href="/" className="underline hover:text-foreground">Zerrow</a>
        </p>
      </div>
    </div>
  );
}

function Row({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-3 text-foreground">
      <span className="text-muted-foreground">{icon}</span>
      <span className="min-w-0 truncate">{children}</span>
    </li>
  );
}
