import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: "Privacy Policy — Zerrow" },
      {
        name: "description",
        content:
          "How Zerrow collects, uses, and protects your data — including Google user data — with encryption and strict access controls.",
      },
      { property: "og:title", content: "Privacy Policy — Zerrow" },
      { property: "og:description", content: "How Zerrow collects, uses, and protects your data." },
      { property: "og:url", content: "https://getzerrow.com/privacy" },
    ],
    links: [{ rel: "canonical", href: "https://getzerrow.com/privacy" }],
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
            Sign in
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-24">
        <p
          className="mb-5 text-xs uppercase tracking-[0.25em]"
          style={{ color: INK_SOFT, ...sora }}
        >
          Legal
        </p>
        <h1 className="text-4xl font-bold tracking-tight md:text-6xl" style={sora}>
          Privacy Policy
        </h1>
        <p className="mt-4 text-sm" style={{ color: INK_SOFT }}>
          Last updated: May 28, 2026
        </p>

        <div className="mt-12 space-y-10 text-base leading-relaxed" style={{ color: INK_SOFT }}>
          <Section title="What we collect">
            When you connect Gmail, Zerrow accesses message metadata, headers, and content for the
            purpose of classifying, summarizing, and filing your email. We also store your Google
            account identifier, email address, and the folder rules you define.
          </Section>
          <Section title="How we use it">
            Email content is processed by AI models to assign your messages to the folders you
            create. Summaries and classifications are stored against your account so the app stays
            fast. We do not sell your data, and we do not use your email content to train
            third-party models.
          </Section>
          <Section title="How we protect Google user data">
            Security procedures are in place to protect the confidentiality of your data. We use
            encryption to protect your information, both in transit and at rest:
            <ul className="mt-3 list-disc space-y-2 pl-6">
              <li>
                All traffic between your browser, Gmail, and Zerrow is encrypted in transit using
                TLS 1.2 or higher.
              </li>
              <li>
                Sensitive content — email subjects, snippets, bodies, recipient lists, AI-generated
                summaries and classification reasons, your saved reply drafts, and contact notes,
                phone numbers, and addresses — is encrypted at the column level using authenticated
                encryption (pgcrypto AEAD) with a server-held key, so the raw text is unreadable
                directly from the database. Routing fields needed to deliver and de-duplicate mail
                (sender address, Gmail message and thread identifiers, labels) are stored alongside
                in our managed Postgres database with disk-level encryption at rest provided by our
                infrastructure provider.
              </li>
              <li>
                Google OAuth access and refresh tokens are encrypted at the column level using a
                server-held key (pgcrypto) and are never exposed to the browser.
              </li>
              <li>
                Row-level security ensures each authenticated user can only access their own data.
                Server-side database access is gated by authenticated server functions that verify
                the requesting user before touching their data.
              </li>
              <li>
                Secrets are stored in a managed secret store rather than in source code or shipped
                to the browser, and production access is restricted.
              </li>
              <li>
                We periodically review our security procedures, dependencies, and access policies to
                keep your data protected.
              </li>
            </ul>
          </Section>
          <Section title="Limited Use of Google user data">
            Zerrow's use and transfer to any other app of information received from Google APIs
            adheres to the{" "}
            <a
              href="https://developers.google.com/terms/api-services-user-data-policy"
              target="_blank"
              rel="noreferrer"
              style={{ color: INK, textDecoration: "underline" }}
            >
              Google API Services User Data Policy
            </a>
            , including the Limited Use requirements.
            <ul className="mt-3 list-disc space-y-2 pl-6">
              <li>
                We use Google user data only to provide and improve the user-facing features of
                Zerrow (classifying, filing, summarizing, and drafting replies to your email).
              </li>
              <li>We do not sell Google user data and we do not use it for advertising.</li>
              <li>
                We do not transfer Google user data to others except as necessary to provide or
                improve these features, comply with applicable law, or as part of a merger,
                acquisition, or sale of assets with notice to users.
              </li>
              <li>
                We do not allow humans to read your Google user data, except with your explicit
                consent, for security and abuse investigations, to comply with applicable law, or
                where the data has been aggregated and anonymized.
              </li>
              <li>
                Email content sent to our AI provider for classification, summarization, and reply
                drafting is processed under that provider's API data-processing terms, which
                prohibit using customer API content to train their generalized models. We do not
                separately train any models on your email content.
              </li>
            </ul>
          </Section>
          <Section title="Sharing">
            We share data only with the infrastructure providers required to run Zerrow: hosting on
            Cloudflare, database and authentication on Supabase (via Lovable Cloud), and AI
            classification via the Lovable AI Gateway. Each provider is bound by their own data
            processing terms. We do not sell your data and we do not use it for advertising.
          </Section>
          <Section title="Retention &amp; deletion">
            You can disconnect Gmail at any time from Settings. Disconnecting revokes your Google
            OAuth tokens at Google, stops further syncing, and removes that mailbox's synced
            messages, search index, reply drafts, calendar contacts, queued jobs, and the encrypted
            token record from our database. You can also delete your entire Zerrow account from
            Settings — this revokes Google access on every connected mailbox and immediately removes
            your synced messages, queued jobs, folders, filters, contacts, search index,
            push-notification logs, and sign-in record from our systems.
          </Section>

          <Section title="Your rights">
            You can request a copy of the data we hold about you, or ask us to delete it, by
            contacting support. If you are in the EU or UK, you have additional rights under GDPR
            including objection and portability.
          </Section>
          <Section title="Contact">Questions about this policy? Email privacy@zerrow.app.</Section>
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
      <div>{children}</div>
    </section>
  );
}
