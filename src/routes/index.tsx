import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { RocketCountdown } from "@/components/landing/RocketCountdown";

export const Route = createFileRoute("/")({
  beforeLoad: async () => {
    const { data } = await supabase.auth.getSession();
    if (data.session) throw redirect({ to: "/inbox" });
  },
  head: () => ({
    meta: [
      { title: "Zerrow — An inbox that sorts itself" },
      { name: "description", content: "Zerrow uses AI to sort your Gmail into the folders you actually use. Stop triaging. Start reading the email that matters." },
      { property: "og:title", content: "Zerrow — An inbox that sorts itself" },
      { property: "og:description", content: "AI-powered Gmail sorting built around the folders you already think in." },
      { name: "twitter:title", content: "Zerrow — An inbox that sorts itself" },
      { name: "twitter:description", content: "AI-powered Gmail sorting built around the folders you already think in." },
    ],
  }),
  component: LandingPage,
});

const BG = "#0c0c14";
const BG_RAISED = "#15151f";
const FG = "#f4f3ee";
const FG_MUTED = "#9a9aa8";
const GOLD = "#e0b54a";

// Map legacy light-theme names to dark tokens to flip the palette.
const PAPER = BG;
const PAPER_DEEP = BG_RAISED;
const INK = FG;
const INK_SOFT = FG_MUTED;

const sora = { fontFamily: "'Sora', ui-sans-serif, system-ui, sans-serif" };
const manrope = { fontFamily: "'Manrope', ui-sans-serif, system-ui, sans-serif" };

function LandingPage() {
  return (
    <div
      className="min-h-screen"
      style={{ background: PAPER, color: INK, ...manrope }}
    >
      <Header />
      <Hero />
      <Marquee />
      <Features />
      <HowItWorks />
      <BigStatement />
      <FAQ />
      <CTA />
      <Footer />
    </div>
  );
}

function Header() {
  return (
    <header
      className="sticky top-0 z-30 border-b backdrop-blur"
      style={{ borderColor: PAPER_DEEP, background: `${PAPER}cc` }}
    >
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <Link to="/" className="text-2xl font-bold tracking-tight" style={sora}>
          Zerrow<span style={{ color: INK_SOFT }}>.</span>
        </Link>
        <nav className="hidden items-center gap-8 text-sm md:flex" style={manrope}>
          <a href="#features" className="hover:opacity-60">Features</a>
          <a href="#how" className="hover:opacity-60">How it works</a>
          <a href="#faq" className="hover:opacity-60">FAQ</a>
        </nav>
        <Link
          to="/login"
          className="rounded-full px-5 py-2 text-sm font-medium transition hover:opacity-85"
          style={{ background: GOLD, color: "#1a1405", ...sora }}
        >
          Sign in
        </Link>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="mx-auto max-w-6xl px-6 pt-24 pb-28 md:pt-36 md:pb-40">
      <div className="grid items-center gap-16 md:grid-cols-[1.2fr_1fr]">
        <div>
          <p
            className="mb-6 text-xs uppercase tracking-[0.25em]"
            style={{ color: GOLD, ...sora }}
          >
            T-minus to Inbox Zero
          </p>
          <h1
            className="text-5xl font-bold leading-[1.02] tracking-tight md:text-7xl"
            style={sora}
          >
            An inbox that{" "}
            <span className="italic" style={{ fontFamily: "'Instrument Serif', serif", fontWeight: 400, color: GOLD }}>
              sorts itself.
            </span>
          </h1>
          <p
            className="mt-8 max-w-xl text-lg leading-relaxed md:text-xl"
            style={{ color: INK_SOFT }}
          >
            Zerrow reads every new email and files it into the folders you
            actually use — newsletters, invoices, cold pitches, calendar
            invites — so the only thing left in your inbox is what deserves
            your attention.
          </p>
          <div className="mt-10 flex flex-wrap items-center gap-4">
            <Link
              to="/login"
              className="rounded-full px-7 py-3.5 text-base font-medium transition hover:translate-y-[-1px] hover:opacity-90"
              style={{ background: GOLD, color: "#1a1405", ...sora }}
            >
              Connect Gmail
            </Link>
            <a
              href="#how"
              className="rounded-full border px-7 py-3.5 text-base font-medium transition hover:opacity-70"
              style={{ borderColor: INK_SOFT, color: INK_SOFT, ...sora }}
            >
              See how it works
            </a>
          </div>
          <p className="mt-6 text-sm" style={{ color: INK_SOFT }}>
            Free to try · 3, 2, 1, launch
          </p>
        </div>

        <div className="relative">
          <RocketCountdown />
        </div>
      </div>
    </section>
  );
}

function Marquee() {
  const items = [
    "Newsletters",
    "Invoices",
    "Cold pitches",
    "Calendar invites",
    "Receipts",
    "Notifications",
    "Recruiters",
    "Updates",
  ];
  return (
    <section
      className="border-y py-6"
      style={{ borderColor: PAPER_DEEP, background: PAPER_DEEP }}
    >
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-center gap-x-10 gap-y-3 px-6 text-sm" style={{ color: INK_SOFT, ...sora }}>
        {items.map((t) => (
          <span key={t} className="uppercase tracking-[0.18em]">
            {t}
          </span>
        ))}
      </div>
    </section>
  );
}

function Features() {
  const features = [
    {
      kicker: "01",
      title: "Folders you define, in plain English",
      body: "Tell Zerrow what belongs in each folder — \"receipts from Stripe\", \"cold sales pitches\", \"calendar invites from clients\". The AI handles the rest. No filter rules, no regex.",
    },
    {
      kicker: "02",
      title: "Real-time sorting as mail arrives",
      body: "Zerrow listens to Gmail's push events. New mail is read, summarized, and moved within seconds — long before you open the app.",
    },
    {
      kicker: "03",
      title: "One-sentence AI summaries",
      body: "Every email gets a single-line summary so you can scan the day in a minute. Open only the ones that need a real reply.",
    },
    {
      kicker: "04",
      title: "Learns from your moves",
      body: "Drag an email into a different folder and Zerrow updates that folder's profile. The next misclassification of the same kind doesn't happen.",
    },
    {
      kicker: "05",
      title: "Reanalyze on demand",
      body: "Added a new folder? Hit Reanalyze on any email and Zerrow reroutes it against your latest rules — no full re-sync required.",
    },
    {
      kicker: "06",
      title: "Suggested replies, when you want them",
      body: "Zerrow drafts a concise, on-tone reply for any thread. You stay in control — review, edit, and send from the same view.",
    },
  ];
  return (
    <section id="features" className="mx-auto max-w-6xl px-6 py-28 md:py-36">
      <div className="mb-16 max-w-2xl">
        <p
          className="mb-5 text-xs uppercase tracking-[0.25em]"
          style={{ color: INK_SOFT, ...sora }}
        >
          Features
        </p>
        <h2 className="text-4xl font-bold tracking-tight md:text-6xl" style={sora}>
          Built for people who'd rather <em style={{ fontFamily: "'Instrument Serif', serif", fontWeight: 400 }}>not</em> live in their inbox.
        </h2>
      </div>
      <div className="grid gap-x-12 gap-y-16 md:grid-cols-2">
        {features.map((f) => (
          <div key={f.kicker}>
            <p className="mb-4 text-sm font-medium tabular-nums" style={{ color: INK_SOFT, ...sora }}>
              {f.kicker}
            </p>
            <h3 className="text-2xl font-semibold leading-tight md:text-3xl" style={sora}>
              {f.title}
            </h3>
            <p className="mt-4 max-w-md text-base leading-relaxed" style={{ color: INK_SOFT }}>
              {f.body}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

function HowItWorks() {
  const steps = [
    {
      n: "Step 1",
      title: "Connect Gmail",
      body: "Sign in with Google. Zerrow connects to your existing Gmail account using OAuth — no password, no migration.",
    },
    {
      n: "Step 2",
      title: "Describe your folders",
      body: "Create a folder and write a one-line rule in plain English. Zerrow learns the rest from a handful of examples.",
    },
    {
      n: "Step 3",
      title: "Open a clean inbox",
      body: "Newsletters land in Newsletters. Receipts land in Receipts. Your inbox shows what's left — the email that actually wants you.",
    },
  ];
  return (
    <section
      id="how"
      className="border-y py-28 md:py-36"
      style={{ borderColor: PAPER_DEEP, background: PAPER_DEEP, color: FG }}
    >
      <div className="mx-auto max-w-6xl px-6">
        <div className="mb-16 max-w-2xl">
          <p
            className="mb-5 text-xs uppercase tracking-[0.25em]"
            style={{ color: GOLD, ...sora }}
          >
            How it works
          </p>
          <h2 className="text-4xl font-bold tracking-tight md:text-6xl" style={sora}>
            Three steps to inbox zero.{" "}
            <span className="italic" style={{ fontFamily: "'Instrument Serif', serif", fontWeight: 400, color: GOLD }}>
              Then it keeps itself there.
            </span>
          </h2>
        </div>
        <div className="grid gap-10 md:grid-cols-3">
          {steps.map((s) => (
            <div
              key={s.n}
              className="rounded-2xl border p-8"
              style={{ borderColor: "#2a2a36", background: "#0c0c14" }}
            >
              <p className="text-xs uppercase tracking-[0.25em]" style={{ color: GOLD, ...sora }}>
                {s.n}
              </p>
              <h3 className="mt-6 text-2xl font-semibold leading-tight" style={sora}>
                {s.title}
              </h3>
              <p className="mt-4 text-base leading-relaxed" style={{ color: FG_MUTED }}>
                {s.body}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function BigStatement() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-32 md:py-44">
      <p
        className="mx-auto max-w-4xl text-center text-3xl font-medium leading-[1.15] md:text-5xl"
        style={sora}
      >
        Email shouldn't be a job.{" "}
        <span
          className="italic"
          style={{ fontFamily: "'Instrument Serif', serif", fontWeight: 400, color: INK_SOFT }}
        >
          Zerrow is the assistant that finally treats it like one — and does it for you.
        </span>
      </p>
    </section>
  );
}

function FAQ() {
  const items = [
    {
      q: "Does Zerrow store my emails?",
      a: "Zerrow syncs message metadata and content so it can classify and summarize. Everything is scoped to your account, and you can disconnect Gmail at any time from Settings.",
    },
    {
      q: "Will it move emails in Gmail itself?",
      a: "Yes — when Zerrow files an email into a folder, it applies the matching Gmail label so your phone, web, and other clients stay in sync.",
    },
    {
      q: "What if it gets it wrong?",
      a: "Move the email to the correct folder and Zerrow learns from it. The next time a similar email arrives, it routes correctly. You can also hit Reanalyze on any single message.",
    },
    {
      q: "Which mail providers are supported?",
      a: "Gmail and Google Workspace today. Other providers may come later.",
    },
  ];
  return (
    <section id="faq" className="mx-auto max-w-4xl px-6 py-28 md:py-36">
      <p
        className="mb-5 text-xs uppercase tracking-[0.25em]"
        style={{ color: INK_SOFT, ...sora }}
      >
        FAQ
      </p>
      <h2 className="mb-14 text-4xl font-bold tracking-tight md:text-5xl" style={sora}>
        Questions, answered.
      </h2>
      <div className="divide-y" style={{ borderColor: PAPER_DEEP }}>
        {items.map((it) => (
          <div key={it.q} className="py-7" style={{ borderTop: `1px solid ${PAPER_DEEP}` }}>
            <h3 className="text-xl font-semibold" style={sora}>
              {it.q}
            </h3>
            <p className="mt-3 text-base leading-relaxed" style={{ color: INK_SOFT }}>
              {it.a}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

function CTA() {
  return (
    <section className="mx-auto max-w-6xl px-6 pb-32">
      <div
        className="rounded-3xl px-10 py-16 text-center md:px-16 md:py-24"
        style={{ background: GOLD, color: "#1a1405" }}
      >
        <h2 className="text-4xl font-bold tracking-tight md:text-6xl" style={sora}>
          Take your inbox back.
        </h2>
        <p className="mx-auto mt-6 max-w-xl text-lg" style={{ color: "#3a2d08" }}>
          Connect Gmail in 30 seconds. Zerrow does the rest.
        </p>
        <Link
          to="/login"
          className="mt-10 inline-block rounded-full px-8 py-4 text-base font-medium transition hover:opacity-90"
          style={{ background: "#0c0c14", color: GOLD, ...sora }}
        >
          Get started — it's free
        </Link>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer
      className="border-t py-10"
      style={{ borderColor: PAPER_DEEP }}
    >
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 text-sm md:flex-row" style={{ color: INK_SOFT }}>
        <p style={sora}>© {new Date().getFullYear()} Zerrow</p>
        <div className="flex items-center gap-6">
          <a href="#features" className="hover:opacity-60">Features</a>
          <Link to="/privacy" className="hover:opacity-60">Privacy</Link>
          <Link to="/terms" className="hover:opacity-60">Terms</Link>
          <Link to="/login" className="hover:opacity-60">Sign in</Link>
        </div>
      </div>
    </footer>
  );
}
