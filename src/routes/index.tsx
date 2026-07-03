import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { useMissionTelemetry } from "@/components/landing/useMissionTelemetry";
import zerrowLogo from "@/assets/zerrow-logo-v2.png";


export const Route = createFileRoute("/")({
  beforeLoad: async () => {
    const { data } = await supabase.auth.getSession();
    if (data.session) throw redirect({ to: "/inbox" });
  },
  head: () => ({
    meta: [
      { title: "Zerrow — An inbox that sorts itself" },
      {
        name: "description",
        content:
          "Zerrow uses AI to sort your Gmail into the folders you actually use. Stop triaging. Start reading the email that matters.",
      },
      { property: "og:title", content: "Zerrow — An inbox that sorts itself" },
      {
        property: "og:description",
        content: "AI-powered Gmail sorting built around the folders you already think in.",
      },
      { property: "og:url", content: "https://getzerrow.com/" },
      { name: "twitter:title", content: "Zerrow — An inbox that sorts itself" },
      {
        name: "twitter:description",
        content: "AI-powered Gmail sorting built around the folders you already think in.",
      },
    ],
    links: [
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap",
      },
      { rel: "stylesheet", href: "/zerrow-landing.css" },
      { rel: "canonical", href: "https://getzerrow.com/" },
    ],
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: [
            {
              "@type": "Question",
              name: "Does Zerrow store my emails?",
              acceptedAnswer: {
                "@type": "Answer",
                text: "Zerrow syncs message metadata and content so it can classify and summarize. Everything is scoped to your account, and you can disconnect Gmail at any time from Settings.",
              },
            },
            {
              "@type": "Question",
              name: "Will it move emails in Gmail itself?",
              acceptedAnswer: {
                "@type": "Answer",
                text: "Yes — when Zerrow files an email into a folder, it applies the matching Gmail label so your phone, web, and other clients stay in sync.",
              },
            },
            {
              "@type": "Question",
              name: "What if it gets it wrong?",
              acceptedAnswer: {
                "@type": "Answer",
                text: "Move the email to the correct folder and Zerrow learns from it. The next time a similar email arrives, it routes correctly. You can also hit Reanalyze on any single message.",
              },
            },
            {
              "@type": "Question",
              name: "Which mail providers are supported?",
              acceptedAnswer: {
                "@type": "Answer",
                text: "Gmail and Google Workspace today. Other providers may come later.",
              },
            },
          ],
        }),
      },
    ],
  }),
  component: LandingPage,
});

function LandingPage() {
  useMissionTelemetry();
  return (
    <>
      {/* CALM TELEMETRY BAR */}
      <div className="statusbar">
        <div className="statusbar__inner">
          <span className="statusbar__status">
            <span className="statusbar__dot" aria-hidden="true"></span>
            Status // Active
          </span>
          <span className="statusbar__pill">Sorting sequence · ZRW-001</span>
          <span className="statusbar__readout">
            Uptime <b id="met-val">T+00:00:00</b>
          </span>
        </div>
      </div>

      {/* NAV */}
      <header className="nav">
        <a href="#top" className="brand">
          <img className="brand__logo" src={zerrowLogo} alt="Zerrow" />
        </a>
        <nav className="nav__links">
          <a href="#features">Features</a>
          <a href="#how">How it works</a>
          <a href="#faq">FAQ</a>
        </nav>
        <div className="nav__cta">
          <Link className="btn btn--ghost" to="/login">
            Sign in
          </Link>
          <Link className="btn btn--primary" to="/login">
            Get started <span aria-hidden="true">→</span>
          </Link>
        </div>
      </header>

      <main>
        {/* HERO — centered */}
        <section className="hero" id="top">
          <div className="hero__chip">
            <span className="statusbar__dot" aria-hidden="true"></span>
            Mission directive · eliminate inbox clutter
          </div>
          <h1 className="hero__title">
            An inbox that <span className="hero__grad">sorts itself.</span>
          </h1>
          <p className="hero__sub">
            Zerrow reads every new email and files it into the folders you actually use —{" "}
            <b>newsletters, invoices, cold pitches, calendar invites</b>. The only thing left in
            your inbox is what deserves your attention.
          </p>
          <div className="hero__cta">
            <Link className="btn btn--primary btn--lg" to="/login">
              Connect Gmail <span aria-hidden="true">→</span>
            </Link>
            <a className="btn btn--ghost btn--lg" href="#how">
              See how it works
            </a>
          </div>
          <div className="hero__fineprint">
            Free to try · Works with your existing Gmail labels
          </div>

          {/* SINGLE DASHBOARD MOCKUP */}
          <div className="dash" aria-label="Zerrow sorting emails in real time">
            <div className="dash__chrome">
              <span className="dash__lights" aria-hidden="true">
                <i></i>
                <i></i>
                <i></i>
              </span>
              <span className="dash__label">ZERROW · LIVE SORTING</span>
            </div>
            <div className="dash__body">
              <div className="dash__stream">
                <div className="dash__row dash__row--active">
                  <span className="dash__folder">Invoices</span>
                  <span className="dash__meta">Stripe · payment received</span>
                  <span className="dash__tag">routed</span>
                </div>
                <div className="dash__row">
                  <span className="dash__folder">Newsletters</span>
                  <span className="dash__meta">The Daily · weekly digest</span>
                  <span className="dash__tag">routed</span>
                </div>
                <div className="dash__row">
                  <span className="dash__folder">Cold pitches</span>
                  <span className="dash__meta">Unsolicited outreach</span>
                  <span className="dash__tag">routed</span>
                </div>
              </div>
              <div className="dash__focus">
                <div className="dash__ring">99%</div>
                <div className="dash__focus-lbl">Classification accuracy</div>
                <div className="dash__focus-sub">
                  <span id="inbox-count">0</span> messages sorted today
                </div>
              </div>
            </div>
          </div>

          {/* STATS */}
          <div className="stats">
            <div className="stat">
              <div className="stat__num">
                <span id="stat-routed">142</span>
              </div>
              <div className="stat__lbl">Messages routed · last 24h</div>
            </div>
            <div className="stat">
              <div className="stat__num">99.2%</div>
              <div className="stat__lbl">Classification accuracy</div>
            </div>
            <div className="stat">
              <div className="stat__num">2.4s</div>
              <div className="stat__lbl">Median sort time</div>
            </div>
          </div>
        </section>

        {/* FEATURES */}
        <section className="section" id="features">
          <header className="sect-head">
            <div className="sect-kicker">Features</div>
            <h2 className="sect-title">
              Built for people who'd rather <em>not</em> live in their inbox.
            </h2>
            <p className="sect-lede">
              Every part of Zerrow is calibrated to one objective: keep the inbox at zero without
              making you babysit it.
            </p>
          </header>

          <div className="cards">
            <article className="card">
              <div className="card__badge">01</div>
              <h3 className="card__title">Folders you define, in plain English</h3>
              <p className="card__body">
                Tell Zerrow what belongs in each folder — receipts from Stripe, cold sales pitches,
                calendar invites from clients. The AI handles the rest. No filter rules, no regex.
              </p>
            </article>
            <article className="card">
              <div className="card__badge">02</div>
              <h3 className="card__title">Real-time sorting as mail arrives</h3>
              <p className="card__body">
                Zerrow listens to Gmail's push events. New mail is read, summarized, and moved
                within seconds — long before you open the app.
              </p>
            </article>
            <article className="card">
              <div className="card__badge">03</div>
              <h3 className="card__title">One-sentence AI summaries</h3>
              <p className="card__body">
                Every email gets a single-line summary so you can scan the day in a minute. Open
                only the ones that need a real reply.
              </p>
            </article>
            <article className="card">
              <div className="card__badge">04</div>
              <h3 className="card__title">Learns from your moves</h3>
              <p className="card__body">
                Drag an email into a different folder and Zerrow updates that folder's profile. The
                next misclassification of the same kind doesn't happen.
              </p>
            </article>
            <article className="card">
              <div className="card__badge">05</div>
              <h3 className="card__title">Reanalyze on demand</h3>
              <p className="card__body">
                Added a new folder? Reanalyze any email and Zerrow reroutes it against your latest
                rules — no full re-sync required.
              </p>
            </article>
            <article className="card">
              <div className="card__badge">06</div>
              <h3 className="card__title">Suggested replies, when you want them</h3>
              <p className="card__body">
                Zerrow drafts a concise, on-tone reply for any thread. You stay in control — review,
                edit, and send from the same view.
              </p>
            </article>
          </div>
        </section>

        {/* HOW IT WORKS */}
        <section className="section" id="how">
          <header className="sect-head">
            <div className="sect-kicker">How it works</div>
            <h2 className="sect-title">
              Three steps to inbox zero. Then it keeps itself there.
            </h2>
            <p className="sect-lede">
              Sign on, describe your folders, hand over the controls. Zerrow takes it from there.
            </p>
          </header>

          <div className="steps">
            <div className="step">
              <div className="step__num">01</div>
              <h3 className="step__title">Connect Gmail</h3>
              <p className="step__body">
                Sign in with Google. Zerrow connects to your existing Gmail account using OAuth — no
                password, no migration.
              </p>
            </div>
            <div className="step">
              <div className="step__num">02</div>
              <h3 className="step__title">Describe your folders</h3>
              <p className="step__body">
                Create a folder and write a one-line rule in plain English. Zerrow learns the rest
                from a handful of examples.
              </p>
            </div>
            <div className="step">
              <div className="step__num">03</div>
              <h3 className="step__title">Open a clean inbox</h3>
              <p className="step__body">
                Newsletters land in Newsletters. Receipts land in Receipts. Your inbox shows what's
                left — the email that actually wants you.
              </p>
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section className="section" id="faq">
          <header className="sect-head">
            <div className="sect-kicker">FAQ</div>
            <h2 className="sect-title">
              Questions, <em>answered</em>.
            </h2>
            <p className="sect-lede">
              Everything you need to know before you hand Zerrow the keys to your inbox.
            </p>
          </header>

          <div className="faq">
            <details className="faq-item" open>
              <summary>
                <span>Does Zerrow store my emails?</span>
                <span className="faq-toggle" aria-hidden="true">
                  +
                </span>
              </summary>
              <div className="faq-body">
                Zerrow syncs message metadata and content so it can classify and summarize.
                Everything is <b>scoped to your account</b>, and you can disconnect Gmail at any
                time from Settings.
              </div>
            </details>
            <details className="faq-item">
              <summary>
                <span>Will it move emails in Gmail itself?</span>
                <span className="faq-toggle" aria-hidden="true">
                  +
                </span>
              </summary>
              <div className="faq-body">
                Yes — when Zerrow files an email into a folder, it applies the matching Gmail label
                so your <b>phone, web, and other clients stay in sync</b>.
              </div>
            </details>
            <details className="faq-item">
              <summary>
                <span>What if it gets it wrong?</span>
                <span className="faq-toggle" aria-hidden="true">
                  +
                </span>
              </summary>
              <div className="faq-body">
                Move the email to the correct folder and Zerrow learns from it. The next time a
                similar email arrives, it routes correctly. You can also hit <b>Reanalyze</b> on any
                single message.
              </div>
            </details>
            <details className="faq-item">
              <summary>
                <span>Which mail providers are supported?</span>
                <span className="faq-toggle" aria-hidden="true">
                  +
                </span>
              </summary>
              <div className="faq-body">
                <b>Gmail and Google Workspace</b> today. Other providers may come later.
              </div>
            </details>
          </div>
        </section>

        {/* CTA */}
        <section className="section cta" id="cta">
          <div className="cta__inner">
            <div className="sect-kicker">Ready for ignition</div>
            <h2 className="cta__title">
              Take your inbox <em>back</em>.
            </h2>
            <p className="cta__sub">
              Connect Gmail in 30 seconds. Zerrow does the rest. Email shouldn't be a job — and
              Zerrow is the assistant that finally treats it like one.
            </p>
            <div className="cta__actions">
              <Link className="btn btn--primary btn--lg" to="/login">
                Get started — it's free <span aria-hidden="true">↗</span>
              </Link>
              <a className="btn btn--ghost btn--lg" href="#features">
                Review features
              </a>
            </div>
          </div>
        </section>

        {/* FOOTER */}
        <footer className="footer">
          <div className="footer__inner">
            <div>© 2026 Zerrow · An inbox that sorts itself</div>
            <div className="footer__trail">
              <span className="statusbar__dot" aria-hidden="true"></span>
              <span>Uptime</span>
              <span id="footer-met">T+00:00:00</span>
            </div>
            <div className="footer__links">
              <a href="#features">Features</a>
              <Link to="/guides/gmail-reminders">Gmail reminders guide</Link>
              <Link to="/privacy">Privacy</Link>
              <Link to="/terms">Terms</Link>
              <Link to="/login">Sign in</Link>
            </div>
          </div>
        </footer>
      </main>
    </>
  );
}

