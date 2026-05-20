import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: "Privacy Policy — Zerrow" },
      { name: "description", content: "How Zerrow collects, uses, and protects your data when you connect your Gmail account." },
      { property: "og:title", content: "Privacy Policy — Zerrow" },
      { property: "og:description", content: "How Zerrow collects, uses, and protects your data." },
    ],
  }),
  component: PrivacyPage,
});

const PAPER = "#0c0c14";
const PAPER_DEEP = "#26262f";
const INK = "#f4f3ee";
const INK_SOFT = "#9a9aa8";
const GOLD = "#e0b54a";
const sora = { fontFamily: "'Sora', ui-sans-serif, system-ui, sans-serif" };
const manrope = { fontFamily: "'Manrope', ui-sans-serif, system-ui, sans-serif" };

function PrivacyPage() {
  return (
    <div className="min-h-screen" style={{ background: PAPER, color: INK, ...manrope }}>
      <header className="sticky top-0 z-30 border-b backdrop-blur" style={{ borderColor: PAPER_DEEP, background: `${PAPER}cc` }}>
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link to="/" className="text-2xl font-bold tracking-tight" style={sora}>
            Zerrow<span style={{ color: INK_SOFT }}>.</span>
          </Link>
          <Link to="/login" className="rounded-full px-5 py-2 text-sm font-medium" style={{ background: GOLD, color: "#1a1405", ...sora }}>
            Sign in
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-24">
        <p className="mb-5 text-xs uppercase tracking-[0.25em]" style={{ color: INK_SOFT, ...sora }}>Legal</p>
        <h1 className="text-4xl font-bold tracking-tight md:text-6xl" style={sora}>Privacy Policy</h1>
        <p className="mt-4 text-sm" style={{ color: INK_SOFT }}>Last updated: May 20, 2026</p>

        <div className="mt-12 space-y-10 text-base leading-relaxed" style={{ color: INK_SOFT }}>
          <Section title="What we collect">
            When you connect Gmail, Zerrow accesses message metadata, headers, and content for the purpose of classifying, summarizing, and filing your email. We also store your Google account identifier, email address, and the folder rules you define.
          </Section>
          <Section title="How we use it">
            Email content is processed by AI models to assign your messages to the folders you create. Summaries and classifications are stored against your account so the app stays fast. We do not sell your data, and we do not use your email content to train third-party models.
          </Section>
          <Section title="Sharing">
            We share data only with infrastructure providers required to run Zerrow (hosting, database, and the AI provider that performs classification). Each provider is bound by their own data processing terms.
          </Section>
          <Section title="Retention &amp; deletion">
            You can disconnect Gmail at any time from Settings. When you delete your account, your synced messages, folder rules, and account record are removed from our systems within 30 days.
          </Section>
          <Section title="Your rights">
            You can request a copy of the data we hold about you, or ask us to delete it, by contacting support. If you are in the EU or UK, you have additional rights under GDPR including objection and portability.
          </Section>
          <Section title="Contact">
            Questions about this policy? Email privacy@zerrow.app.
          </Section>
        </div>

        <div className="mt-16">
          <Link to="/" className="text-sm underline" style={sora}>← Back to home</Link>
        </div>
      </main>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-3 text-xl font-semibold" style={{ color: INK, ...sora }}>{title}</h2>
      <p>{children}</p>
    </section>
  );
}
