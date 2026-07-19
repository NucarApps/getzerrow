import { createFileRoute, Link } from "@tanstack/react-router";

const TITLE = "How to use an AI agent to sort your emails (2026 guide)";
const DESCRIPTION =
  "Learn how to use an AI agent to sort your Gmail automatically — from setting up folders to letting Zerrow triage your inbox so only what needs a human shows up.";
const URL = "https://getzerrow.com/guides/ai-sorting-agent";

export const Route = createFileRoute("/guides/ai-sorting-agent")({
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
          name: "Use an AI agent to sort your emails",
          description: DESCRIPTION,
          step: [
            {
              "@type": "HowToStep",
              name: "Connect your Gmail account",
              text: "Connect Gmail so the AI agent can read incoming mail and file it on your behalf.",
            },
            {
              "@type": "HowToStep",
              name: "Define the folders you actually use",
              text: "Create the buckets you think in — clients, receipts, newsletters, awaiting reply — so the agent has clear destinations.",
            },
            {
              "@type": "HowToStep",
              name: "Let the agent triage every new email",
              text: "The AI agent reads, classifies, and routes each message automatically, keeping only what needs a human in your inbox.",
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
              name: "What is an AI email sorting agent?",
              acceptedAnswer: {
                "@type": "Answer",
                text: "An AI email sorting agent is software that reads each incoming email, understands what it is about, and files it into the right folder automatically — combining deterministic filters with AI classification so your inbox shows only what needs a human.",
              },
            },
            {
              "@type": "Question",
              name: "How do I use an AI agent to sort my Gmail?",
              acceptedAnswer: {
                "@type": "Answer",
                text: "Connect Gmail to a tool like Zerrow, define the folders you actually use, and let the agent classify and route every new message in real time. You review one clean inbox instead of triaging everything by hand.",
              },
            },
            {
              "@type": "Question",
              name: "Is an AI sorting agent better than Gmail filters?",
              acceptedAnswer: {
                "@type": "Answer",
                text: "Gmail filters are rigid rules you maintain by hand. An AI agent understands context, learns from your folders, and handles messages that no static rule anticipated, so it keeps working as your inbox changes.",
              },
            },
          ],
        }),
      },
    ],
  }),
  component: AiSortingAgentGuide,
});

const PAPER = "#0c0c14";
const PAPER_DEEP = "#26262f";
const INK = "#f4f3ee";
const INK_SOFT = "#b4b4c0";
const GOLD = "#e0b54a";
const sora = { fontFamily: "'Sora', ui-sans-serif, system-ui, sans-serif" };
const manrope = { fontFamily: "'Manrope', ui-sans-serif, system-ui, sans-serif" };

function AiSortingAgentGuide() {
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
          How to use an AI agent to sort your emails
        </h1>
        <p className="mt-4 text-sm" style={{ color: INK_SOFT }}>
          Last updated: July 11, 2026 · 6 min read
        </p>

        <div className="mt-12 space-y-10 text-base leading-relaxed" style={{ color: INK_SOFT }}>
          <p>
            Manual inbox triage does not scale. Once you get more than a handful of emails a day,
            the time you spend sorting, archiving, and deciding what matters adds up fast. An AI
            agent takes that work off your plate — it reads every message, decides where it belongs,
            and files it automatically. This guide shows how to set one up and get to a genuinely
            quiet inbox.
          </p>

          <Section title="What an AI sorting agent actually does">
            Unlike a static filter, an AI agent reads the full context of an email — sender,
            subject, body, and intent — and routes it the way a thoughtful assistant would. It
            combines deterministic rules (for the obvious cases) with AI classification (for
            everything else), so it keeps working even when a message does not match any rule you
            wrote.
          </Section>

          <Section title="1. Connect your Gmail account">
            Start by connecting Gmail so the agent can see incoming mail and act on it. With Zerrow
            this is a one-step sign-in: authorize access and the agent begins watching your inbox in
            real time, filing new mail as it arrives.
          </Section>

          <Section title="2. Define the folders you think in">
            An agent is only as useful as the destinations you give it. Create the buckets that
            match how you actually work — clients, receipts, newsletters, awaiting reply, needs a
            decision. You can describe each folder in plain language, and the agent uses that
            description to decide what belongs there.
          </Section>

          <Section title="3. Let the agent triage every new email">
            From here it runs on its own. Each incoming message is read, classified, and routed into
            the right folder, with optional side-effects like auto-archiving newsletters or marking
            receipts as read. What is left in your inbox is the short list that genuinely needs a
            human — you.
          </Section>

          <Section title="4. Let it learn from your corrections">
            When you move a message the agent misfiled, it learns. Over time the classification
            sharpens to your specific patterns, so the folders you use most become more accurate the
            longer you run it. This is the advantage of an agent over fixed filters: it adapts
            instead of going stale.
          </Section>

          <Section title="AI agent vs. Gmail filters">
            Gmail filters are rules you build and maintain by hand, one condition at a time. They
            break the moment a sender changes or a new type of email shows up. An AI agent
            understands meaning, generalizes across messages, and handles the long tail no rule
            anticipated — so you spend your time replying, not maintaining filters.
          </Section>
        </div>

        <div
          className="mt-16 rounded-2xl border p-8"
          style={{ borderColor: PAPER_DEEP, background: "#12121c" }}
        >
          <h2 className="text-2xl font-bold" style={{ color: INK, ...sora }}>
            Put an agent to work on your inbox
          </h2>
          <p className="mt-3" style={{ color: INK_SOFT }}>
            Zerrow reads every email and files it into the folders you actually use, so only what
            needs a human reaches you. Connect Gmail and try it free.
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
