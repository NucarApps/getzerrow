import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { AtzroLogo } from "@/components/AtzroLogo";

export const Route = createFileRoute("/")({
  beforeLoad: async () => {
    const { data } = await supabase.auth.getSession();
    if (data.session) throw redirect({ to: "/inbox" });
  },
  head: () => ({
    meta: [
      { title: "Atzro — Your inbox, sorted before you open it" },
      {
        name: "description",
        content:
          "Atzro sorts your Gmail automatically. Newsletters, receipts, and cold pitches file themselves into your folders, so your inbox holds only the mail that needs you.",
      },
      { property: "og:type", content: "website" },
      { property: "og:title", content: "Atzro — Your inbox, sorted before you open it" },
      {
        property: "og:description",
        content:
          "Atzro sorts your Gmail automatically, so your inbox holds only the mail that needs you.",
      },
      { property: "og:url", content: "https://getzerrow.com/" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "Atzro — Your inbox, sorted before you open it" },
      {
        name: "twitter:description",
        content:
          "Atzro sorts your Gmail automatically, so your inbox holds only the mail that needs you.",
      },
    ],
    links: [
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Sora:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&family=Instrument+Serif:ital@0;1&display=swap",
      },
      { rel: "stylesheet", href: "/atzro-landing.css" },
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
              name: "Does Atzro store my emails?",
              acceptedAnswer: {
                "@type": "Answer",
                text: "Atzro syncs message metadata and content so it can classify and summarize. Sensitive content is encrypted at rest, everything is scoped to your account, and you can disconnect Gmail at any time from Settings.",
              },
            },
            {
              "@type": "Question",
              name: "Will it move emails in Gmail itself?",
              acceptedAnswer: {
                "@type": "Answer",
                text: "Yes — when Atzro files an email into a folder, it applies the matching Gmail label so your phone, web, and other clients stay in sync.",
              },
            },
            {
              "@type": "Question",
              name: "What if an email lands in the wrong folder?",
              acceptedAnswer: {
                "@type": "Answer",
                text: "Move the email to the right folder and Atzro learns from it. You can reanalyze any message, and the rule activity log shows exactly why each decision was made.",
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
  return (
    <div className="landing">
      {/* NAV */}
      <header className="nav">
        <a href="#top" className="brand">
          <AtzroLogo className="h-9 text-[26px]" />
        </a>
        <nav className="nav__links">
          <a href="#features">Features</a>
          <a href="#contacts">Contacts</a>
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
        {/* HERO */}
        <section className="hero" id="top">
          <div>
            <div className="kicker">Automatic sorting for Gmail</div>
            <h1 className="hero__title">
              Your inbox, sorted <span className="accent">before you open it.</span>
            </h1>
            <p className="hero__sub">
              Describe your folders in plain English. Atzro reads every new message, files it where
              it belongs, labels it in Gmail, and leaves your inbox holding only the mail that
              actually needs you.
            </p>
            <div className="hero__cta">
              <Link className="btn btn--primary btn--lg" to="/login">
                Connect Gmail <span aria-hidden="true">→</span>
              </Link>
              <a className="btn btn--ghost btn--lg" href="#features">
                See how it sorts
              </a>
            </div>
            <div className="hero__fineprint">
              Free to try · Uses your existing Gmail labels · Disconnect any time
            </div>
          </div>

          {/* Product mock */}
          <div className="mock" aria-hidden="true">
            <div className="mock__bar">
              <span className="mock__dot" />
              <span className="mock__dot" />
              <span className="mock__dot" />
              <span className="mock__title">Sorted just now</span>
            </div>
            <div className="mock__row">
              <div className="mock__who">
                <div className="mock__name">Stripe</div>
                <div className="mock__sub">Your invoice for August is ready</div>
              </div>
              <span className="chip chip--violet">Receipts</span>
            </div>
            <div className="mock__row">
              <div className="mock__who">
                <div className="mock__name">The Morning Brief</div>
                <div className="mock__sub">Five things to know today</div>
              </div>
              <span className="chip chip--pink">Newsletters</span>
            </div>
            <div className="mock__row">
              <div className="mock__who">
                <div className="mock__name">Unknown sender</div>
                <div className="mock__sub">Quick call this week?</div>
              </div>
              <span className="chip chip--coral">Cold outreach</span>
            </div>
            <div className="mock__row">
              <div className="mock__who">
                <div className="mock__name">Dana Reyes</div>
                <div className="mock__sub">Re: Thursday walkthrough — one question</div>
              </div>
              <span className="chip chip--inbox">Stays in inbox</span>
            </div>
          </div>
        </section>

        {/* STATS */}
        <div className="stats">
          <div className="stat">
            <div className="stat__num">1,248</div>
            <div className="stat__lbl">Messages sorted since breakfast</div>
          </div>
          <div className="stat stat--brand">
            <div className="stat__num">99.2%</div>
            <div className="stat__lbl">Filed into the right folder</div>
          </div>
          <div className="stat">
            <div className="stat__num">2.4s</div>
            <div className="stat__lbl">Average time to file</div>
          </div>
        </div>

        {/* FEATURES */}
        <section className="section" id="features">
          <header className="sect-head">
            <div className="kicker">What it does</div>
            <h2 className="sect-title">
              You name the folders. <span className="accent">Atzro does the filing.</span>
            </h2>
            <p className="sect-lede">
              A folder is a name plus a one-line description. Write it the way you'd explain it to
              an assistant — Atzro handles the rest.
            </p>
          </header>

          <div className="cards">
            <article className="card">
              <div className="card__mark" />
              <div className="card__tag">Newsletters</div>
              <h3>Digests you read on purpose</h3>
              <p>
                "Anything with an unsubscribe link." Every issue arrives with a one-line summary, so
                catching up takes a coffee, not an afternoon.
              </p>
            </article>
            <article className="card">
              <div className="card__mark card__mark--pink" />
              <div className="card__tag">Receipts</div>
              <h3>Every invoice, in one place</h3>
              <p>
                Payment receipts, renewals, expenses. Filed instantly, labeled in Gmail, and easy to
                find the day your accountant asks.
              </p>
            </article>
            <article className="card">
              <div className="card__mark card__mark--coral" />
              <div className="card__tag">Cold outreach</div>
              <h3>Pitches never reach your inbox</h3>
              <p>
                Unsolicited outreach is detected and filed away, while the calendar guard keeps real
                people you're meeting out of the filter.
              </p>
            </article>
            <article className="card">
              <div className="card__mark card__mark--muted" />
              <div className="card__tag">Your inbox</div>
              <h3>Only the mail that matters</h3>
              <p>
                Surface rules keep personal messages visible even when a folder claims them, and
                trusted senders always come through.
              </p>
            </article>
          </div>

          <p className="cards__note">
            Filed something wrong? Move it and Atzro learns. Every decision is logged —{" "}
            <b>which rule fired, what the AI decided, and at what confidence.</b>
          </p>
        </section>

        {/* CONTACTS + SECURITY */}
        <section className="section" id="contacts">
          <header className="sect-head">
            <div className="kicker">Beyond the inbox</div>
            <h2 className="sect-title" style={{ marginBottom: 0 }}>
              An address book that <span className="accent">keeps itself current.</span>
            </h2>
          </header>

          <div className="duo">
            <article className="duo__panel duo__panel--pink">
              <div className="card__tag">Contacts</div>
              <h3 className="duo__title">A roster that writes itself</h3>
              <p className="duo__body">
                Every email quietly improves your address book: AI-written bios, automatic company
                groups, duplicates merged in one tap, and signature scanning that fills in phone
                numbers and titles for you.
              </p>
              <ul className="duo__list">
                <li>AI bios and relationship summaries</li>
                <li>Duplicate detection with one-tap merge</li>
                <li>Smart company and role groups</li>
                <li>Synced to iPhone (CardDAV) and Google</li>
              </ul>
            </article>
            <article className="duo__panel duo__panel--brand">
              <div className="card__tag">Security</div>
              <h3 className="duo__title">Your mail stays yours</h3>
              <p className="duo__body">
                Content, summaries, and contact details are encrypted at rest. Google OAuth with
                least-privilege scopes means we never see a password, and every row of data is
                sealed to your account.
              </p>
              <ul className="duo__list">
                <li>Content encrypted at rest</li>
                <li>Google OAuth — no passwords stored</li>
                <li>Row-level security on every table</li>
                <li>Disconnect and purge any time</li>
              </ul>
            </article>
          </div>
        </section>

        {/* HOW IT WORKS */}
        <section className="section" id="how">
          <header className="sect-head">
            <div className="kicker">How it works</div>
            <h2 className="sect-title">
              Three steps to <span className="accent">a quiet inbox.</span>
            </h2>
            <p className="sect-lede">Ninety seconds of setup, then the sorting runs itself.</p>
          </header>

          <div className="steps">
            <div className="step">
              <div className="step__num">1</div>
              <h3 className="step__title">Connect with Google</h3>
              <p className="step__body">
                OAuth, not passwords. Your Gmail stays exactly where it is — Atzro just reads and
                labels.
              </p>
            </div>
            <div className="step">
              <div className="step__num">2</div>
              <h3 className="step__title">Describe your folders</h3>
              <p className="step__body">
                One plain-English line per folder. "Receipts and renewals." Done — Atzro learns the
                rest from examples.
              </p>
            </div>
            <div className="step">
              <div className="step__num">3</div>
              <h3 className="step__title">Open a calm inbox</h3>
              <p className="step__body">
                New mail sorts itself in seconds, labels sync everywhere, and your inbox holds only
                what matters.
              </p>
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section className="section" id="faq">
          <header className="sect-head">
            <div className="kicker">Questions</div>
            <h2 className="sect-title" style={{ marginBottom: 0 }}>
              The things <span className="accent">people ask first.</span>
            </h2>
          </header>

          <div className="faq">
            <details className="faq-item" open>
              <summary>
                <span className="faq-q">Does Atzro store my emails?</span>
                <span className="faq-toggle" aria-hidden="true">
                  +
                </span>
              </summary>
              <div className="faq-body">
                Atzro syncs message metadata and content so it can classify and summarize. Sensitive
                content is <b>encrypted at rest</b>, everything is <b>scoped to your account</b>,
                and you can disconnect Gmail at any time from Settings.
              </div>
            </details>
            <details className="faq-item">
              <summary>
                <span className="faq-q">Will it move emails in Gmail itself?</span>
                <span className="faq-toggle" aria-hidden="true">
                  +
                </span>
              </summary>
              <div className="faq-body">
                Yes — when Atzro files an email into a folder, it applies the matching Gmail label
                so your <b>phone, web, and other clients stay in sync</b>.
              </div>
            </details>
            <details className="faq-item">
              <summary>
                <span className="faq-q">What if an email lands in the wrong folder?</span>
                <span className="faq-toggle" aria-hidden="true">
                  +
                </span>
              </summary>
              <div className="faq-body">
                Move the email to the right folder and Atzro learns from it. Hit <b>Reanalyze</b> on
                any message, and the <b>rule activity log</b> shows exactly why each decision was
                made.
              </div>
            </details>
            <details className="faq-item">
              <summary>
                <span className="faq-q">Which mail providers are supported?</span>
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
        <section className="section" style={{ paddingTop: 72 }}>
          <div className="cta__inner">
            <h2 className="cta__title">
              Give your inbox <span className="accent">a filing system.</span>
            </h2>
            <p className="cta__sub">
              Thirty seconds to connect Gmail. After that, every email knows where it belongs — and
              so do you.
            </p>
            <div className="cta__actions">
              <Link className="btn btn--primary btn--lg" to="/login">
                Get started — it's free <span aria-hidden="true">↗</span>
              </Link>
              <a className="btn btn--ghost btn--lg" href="#how">
                See how it works
              </a>
            </div>
          </div>
        </section>

        {/* FOOTER */}
        <footer className="footer">
          <div className="footer__inner">
            <div>© 2026 Atzro · Automatic sorting for Gmail</div>
            <div className="footer__status">
              <i aria-hidden="true"></i>
              <span>All systems operational</span>
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
    </div>
  );
}
