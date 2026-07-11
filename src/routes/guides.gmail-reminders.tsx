import { createFileRoute, Link } from "@tanstack/react-router";

const TITLE = "How to set up Gmail reminders and follow-ups (2026 guide)";
const DESCRIPTION =
  "Set up Gmail reminders and follow-ups using native nudges, snooze, and Zerrow's AI-powered folders to automate your inbox workflow.";
const URL = "https://getzerrow.com/guides/gmail-reminders";

export const Route = createFileRoute("/guides/gmail-reminders")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:type", content: "article" },
      { property: "og:url", content: URL },
      { name: "twitter:title", content: TITLE },
      { name: "twitter:description", content: DESCRIPTION },
    ],
    links: [{ rel: "canonical", href: URL }],
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "HowTo",
          name: "Set up Gmail reminders and follow-ups",
          description: DESCRIPTION,
          step: [
            {
              "@type": "HowToStep",
              name: "Use Gmail's built-in nudges",
              text: "Turn on Nudges in Gmail settings so Gmail surfaces emails you may have forgotten to reply to or follow up on.",
            },
            {
              "@type": "HowToStep",
              name: "Snooze emails to a future time",
              text: "Snooze a message so it returns to the top of your inbox exactly when you need to act on it.",
            },
            {
              "@type": "HowToStep",
              name: "Automate follow-ups with Zerrow",
              text: "Create a Zerrow folder for awaiting-reply emails and let AI classification route messages that need a follow-up automatically.",
            },
          ],
        }),
      },
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: [
            {
              "@type": "Question",
              name: "Does Gmail have a built-in reminder feature?",
              acceptedAnswer: {
                "@type": "Answer",
                text: "Gmail has Nudges, which resurface emails you may need to reply to or follow up on, plus Snooze to bring a message back at a chosen time. Neither is a full reminder system, which is why many people layer automation on top.",
              },
            },
            {
              "@type": "Question",
              name: "How do I set an automatic follow-up reminder in Gmail?",
              acceptedAnswer: {
                "@type": "Answer",
                text: "Use Snooze for one-off reminders, or automate it: with Zerrow you create an 'Awaiting reply' folder and AI classification routes sent and waiting messages into it so follow-ups never slip.",
              },
            },
            {
              "@type": "Question",
              name: "Can AI handle email follow-ups for me?",
              acceptedAnswer: {
                "@type": "Answer",
                text: "Yes. Zerrow reads each incoming email, classifies it, and files it into the folders you actually use, so reminders and follow-ups surface automatically instead of relying on you to remember.",
              },
            },
          ],
        }),
      },
    ],
  }),
  component: GmailRemindersGuide,
});

const PAPER = "#0c0c14";
const PAPER_DEEP = "#26262f";
const INK = "#f4f3ee";
const INK_SOFT = "#b4b4c0";
const GOLD = "#e0b54a";
const sora = { fontFamily: "'Sora', ui-sans-serif, system-ui, sans-serif" };
const manrope = { fontFamily: "'Manrope', ui-sans-serif, system-ui, sans-serif" };

function GmailRemindersGuide() {
  return (
    <div className="min-h-screen" style={{ background: PAPER, color: INK, ...manrope }}>
      <header
        className="sticky top-0 z-30 border-b backdrop-blur"
        style={{ borderColor: PAPER_DEEP, background: `${PAPER}cc` }}
      >
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link to="/" className="text-2xl font-bold tracking-tight" style={sora}>
            Zerrow<span style={{ color: INK_SOFT }}>.</span>
          </Link>
          <Link
            to="/login"
            className="rounded-full px-5 py-2 text-sm font-medium"
            style={{ background: GOLD, color: "#1a1405", ...sora }}
          >
            Connect Gmail
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-24">
        <p className="mb-5 text-xs uppercase tracking-[0.25em]" style={{ color: GOLD, ...sora }}>
          Guide
        </p>
        <h1 className="text-4xl font-bold tracking-tight md:text-6xl" style={sora}>
          How to set up Gmail reminders and follow-ups
        </h1>
        <p className="mt-4 text-sm" style={{ color: INK_SOFT }}>
          Last updated: June 21, 2026 · 6 min read
        </p>

        <div className="mt-12 space-y-10 text-base leading-relaxed" style={{ color: INK_SOFT }}>
          <p>
            Email only works when the right messages come back at the right time. Gmail gives you a
            few native tools for this, but they rely on you remembering to use them. This guide
            walks through the built-in options, then shows how to automate reminders and follow-ups
            so nothing slips through.
          </p>

          <Section title="1. Turn on Gmail nudges">
            Nudges resurface emails Gmail thinks you forgot to reply to, or that you sent and never
            heard back on. Open <em>Settings → See all settings → General → Nudges</em> and enable
            both options. It is the lowest-effort reminder Gmail offers, but it is a suggestion
            engine — it will not catch every thread that matters to you.
          </Section>

          <Section title="2. Snooze messages to a future time">
            Snooze removes an email from your inbox and brings it back at a time you choose. Hover
            any message and click the clock icon, then pick a preset or a custom time. Use it as a
            manual reminder: snooze a waiting-on-reply thread to tomorrow morning and it lands back
            on top. The catch is that you have to snooze every message by hand.
          </Section>

          <Section title="3. Star and label waiting-for-reply emails">
            A common manual system is to star sent emails that need a reply and create a "Waiting"
            label. It works, but it is entirely manual upkeep — you have to remember to star, label,
            and check the label regularly. The moment your inbox gets busy, the system breaks down.
          </Section>

          <Section title="4. Automate follow-ups with Zerrow">
            This is where automation pays off. Zerrow reads every incoming email, classifies it with
            AI, and files it into the folders you actually use. To turn that into a reminder system:
            <br />
            <br />
            Create an <strong>Awaiting reply</strong> folder, add a simple rule (for example,
            replies to threads you started, or emails that mention a deadline), and let AI
            classification do the routing. Instead of remembering to star and snooze, you open one
            folder and see exactly what needs a human. Pair it with Gmail's snooze for time-based
            nudges and you get both deadline reminders and follow-up tracking without the manual
            overhead.
          </Section>

          <Section title="When to automate vs. do it manually">
            If you get a handful of emails a day, nudges and snooze are plenty. Once your inbox is
            high-volume — sales, support, founders, ops — the manual systems fall apart, and
            AI-driven folders that sort and surface follow-ups for you save real time every day.
          </Section>
        </div>

        <div
          className="mt-16 rounded-2xl border p-8"
          style={{ borderColor: PAPER_DEEP, background: "#12121c" }}
        >
          <h2 className="text-2xl font-bold" style={{ color: INK, ...sora }}>
            Let your inbox remind you
          </h2>
          <p className="mt-3" style={{ color: INK_SOFT }}>
            Zerrow files every email into the folders you think in, so follow-ups surface
            automatically. Connect Gmail and try it free.
          </p>
          <Link
            to="/login"
            className="mt-6 inline-block rounded-full px-6 py-3 text-sm font-medium"
            style={{ background: GOLD, color: "#1a1405", ...sora }}
          >
            Connect Gmail
          </Link>
        </div>

        <div className="mt-16">
          <Link to="/" className="text-sm underline" style={sora}>
            ← Back to home
          </Link>
        </div>
      </main>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-3 text-xl font-semibold" style={{ color: INK, ...sora }}>
        {title}
      </h2>
      <p>{children}</p>
    </section>
  );
}
