import { createFileRoute, notFound } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useServerFn } from "@tanstack/react-start";
import { QRCodeSVG } from "qrcode.react";
import { Mail, Phone, Globe, Linkedin, Twitter, Building2, Download, Share2 } from "lucide-react";
import { getPublicCard, getPublicVCard } from "@/lib/cards.functions";
import { logCardEvent } from "@/lib/card-analytics.functions";
import { getTheme } from "@/components/cards/themes";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

const SITE_URL = "https://getzerrow.com";

export const Route = createFileRoute("/c/$handle")({
  loader: async ({ params }) => {
    const r = await getPublicCard({ data: { handle: params.handle } });
    if (!r.card) throw notFound();
    return r;
  },
  head: ({ loaderData, params }) => {
    const card = loaderData?.card;
    if (!card) return { meta: [{ title: "Card not found" }] };
    const title = `${card.name || card.handle} — Contact card`;
    const desc = card.tagline || `${card.name || ""}${card.title ? " · " + card.title : ""}${card.company ? " · " + card.company : ""}`.trim() || "View and save my contact info.";
    const url = `${SITE_URL}/c/${params.handle}`;
    const ogImage = `${SITE_URL}/api/public/og/card/${params.handle}`;
    return {
      meta: [
        { title },
        { name: "description", content: desc },
        { property: "og:title", content: title },
        { property: "og:description", content: desc },
        { property: "og:url", content: url },
        { property: "og:type", content: "profile" },
        { property: "og:image", content: ogImage },
        { property: "og:image:width", content: "1200" },
        { property: "og:image:height", content: "630" },
        { name: "twitter:card", content: "summary_large_image" },
        { name: "twitter:title", content: title },
        { name: "twitter:description", content: desc },
        { name: "twitter:image", content: ogImage },
      ],
      links: [{ rel: "canonical", href: url }],
    };
  },
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
  const logEvent = useServerFn(logCardEvent);
  const loggedView = useRef(false);

  useEffect(() => {
    if (!card || loggedView.current) return;
    loggedView.current = true;
    logEvent({
      data: {
        handle: card.handle,
        event_type: "view",
        referrer: typeof document !== "undefined" ? document.referrer.slice(0, 500) : undefined,
      },
    }).catch(() => {});
  }, [card, logEvent]);

  if (!card) return null;
  const publicUrl = typeof window !== "undefined" ? window.location.href : "";

  function track(kind: "email" | "phone" | "website" | "linkedin" | "twitter", url: string) {
    logEvent({ data: { handle: card!.handle, event_type: "link_click", link_kind: kind, link_url: url.slice(0, 500) } }).catch(() => {});
  }

  async function download() {
    logEvent({ data: { handle: card!.handle, event_type: "vcard_download" } }).catch(() => {});
    const r = await getPublicVCard({ data: { handle: card!.handle, publicUrl } });
    const blob = new Blob([r.vcard], { type: "text/vcard" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${card!.name || card!.handle}.vcf`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const theme = getTheme((card as any).theme);
  const coverUrl = (card as any).cover_url as string | null;
  const avatarUrl = (card as any).avatar_url as string | null;

  return (
    <div className="min-h-screen bg-gradient-to-b from-background via-background to-card text-foreground">
      <div className="mx-auto max-w-md px-4 py-12">
        <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
          {coverUrl ? (
            <div className="h-32 w-full overflow-hidden">
              <img src={coverUrl} alt="" className="h-full w-full object-cover" />
            </div>
          ) : (
            <div className={cn("h-32 bg-gradient-to-br", theme.gradient)} />
          )}
          <div className="px-6 pb-6 -mt-12">
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt={card.name ?? card.handle}
                className="h-24 w-24 rounded-full border-4 border-card object-cover"
              />
            ) : (
              <div className={cn("grid h-24 w-24 place-items-center rounded-full border-4 border-card text-3xl font-semibold bg-gradient-to-br", theme.gradient)}>
                {(card.name || card.handle).slice(0, 1).toUpperCase()}
              </div>
            )}
            <h1 className="mt-4 font-display text-2xl text-foreground">{card.name || card.handle}</h1>
            {card.title && <p className="text-sm text-muted-foreground">{card.title}</p>}
            {card.tagline && <p className="mt-3 text-sm italic text-foreground/80">"{card.tagline}"</p>}

            <ul className="mt-6 space-y-2 text-sm">
              {card.company && <Row icon={<Building2 className="h-4 w-4" />}>{card.company}</Row>}
              {card.email && <Row icon={<Mail className="h-4 w-4" />}><a href={`mailto:${card.email}`} onClick={() => track("email", `mailto:${card.email}`)} className="hover:underline">{card.email}</a></Row>}
              {card.phone && <Row icon={<Phone className="h-4 w-4" />}><a href={`tel:${card.phone}`} onClick={() => track("phone", `tel:${card.phone}`)} className="hover:underline">{card.phone}</a></Row>}
              {card.website && <Row icon={<Globe className="h-4 w-4" />}><a href={card.website} target="_blank" rel="noreferrer" onClick={() => track("website", card.website!)} className="hover:underline">{card.website}</a></Row>}
              {card.linkedin && <Row icon={<Linkedin className="h-4 w-4" />}><a href={card.linkedin} target="_blank" rel="noreferrer" onClick={() => track("linkedin", card.linkedin!)} className="hover:underline">LinkedIn</a></Row>}
              {card.twitter && <Row icon={<Twitter className="h-4 w-4" />}><a href={card.twitter} target="_blank" rel="noreferrer" onClick={() => track("twitter", card.twitter!)} className="hover:underline">Twitter / X</a></Row>}
            </ul>

            <div className="mt-6 grid gap-2 sm:grid-cols-2">
              <button
                onClick={download}
                className={cn("flex items-center justify-center gap-2 rounded-md px-4 py-2.5 text-sm font-medium hover:opacity-90", theme.accent)}
              >
                <Download className="h-4 w-4" /> Save (.vcf)
              </button>
              <button
                onClick={async () => {
                  const shareData = {
                    title: `${card!.name || card!.handle} — Contact card`,
                    text: card!.tagline || `${card!.name || ""}${card!.title ? " · " + card!.title : ""}`.trim() || "My contact card",
                    url: publicUrl,
                  };
                  try {
                    if (typeof navigator !== "undefined" && navigator.share) {
                      await navigator.share(shareData);
                    } else {
                      await navigator.clipboard.writeText(publicUrl);
                      toast.success("Link copied");
                    }
                  } catch (e: any) {
                    if (e?.name !== "AbortError") toast.error("Couldn't share");
                  }
                }}
                className="flex items-center justify-center gap-2 rounded-md border border-border bg-card px-4 py-2.5 text-sm font-medium text-foreground hover:bg-accent"
              >
                <Share2 className="h-4 w-4" /> Share card
              </button>
            </div>




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
