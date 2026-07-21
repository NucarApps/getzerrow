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
                text: "Zerrow syncs message metadata and content so it can classify and summarize. Sensitive content is encrypted at rest, everything is scoped to your account, and you can disconnect Gmail at any time from Settings.",
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
                text: "Move the email to the correct folder and Zerrow learns from it. The next time a similar email arrives, it routes correctly. You can also hit Reanalyze on any single message, and the Rule activity log shows exactly why each decision was made.",
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
    <div className="landing">
      {/* DEEP-SPACE BACKDROP — parallax star layers + one calm comet */}
      <div className="sky" aria-hidden="true">
        <div className="sky__stars sky__stars--far"></div>
        <div className="sky__stars sky__stars--near"></div>
        <div className="sky__comet"></div>
      </div>

      {/* CALM TELEMETRY BAR */}
      <div className="statusbar">
        <div className="statusbar__inner">
          <span className="statusbar__status">
            <span className="statusbar__dot" aria-hidden="true"></span>
            Status // All systems nominal
          </span>
          <span className="statusbar__pill">Sorting sequence · ZRW-001</span>
          <span className="statusbar__readout">
            Mission clock <b id="met-val">T+00:00:00</b>
          </span>
        </div>
      </div>

      {/* NAV */}
      <header className="nav">
        <a href="#top" className="brand">
          <img className="brand__logo" src={zerrowLogo} alt="Zerrow" />
        </a>
        <nav className="nav__links">
          <a href="#features">Flight systems</a>
          <a href="#beyond">Beyond the inbox</a>
          <a href="#how">Launch sequence</a>
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
          <div className="hero__horizon" aria-hidden="true"></div>
          <div className="hero__chip">
            <span className="statusbar__dot" aria-hidden="true"></span>
            Mission directive · eliminate inbox clutter
          </div>
          <h1 className="hero__title">
            An inbox that <span className="hero__grad">sorts itself.</span>
          </h1>
          <p className="hero__sub">
            Zerrow reads every new email the second it lands and files it into the folders you
            actually use — <b>newsletters, invoices, cold pitches, calendar invites</b>. The only
            thing left in orbit is the email that deserves your attention.
          </p>
          <div className="hero__cta">
            <Link className="btn btn--primary btn--lg" to="/login">
              Connect Gmail <span aria-hidden="true">→</span>
            </Link>
            <a className="btn btn--ghost btn--lg" href="#how">
              See the launch sequence
            </a>
          </div>
          <div className="hero__fineprint">Free to try · Works with your existing Gmail labels</div>

          {/* MISSION CONSOLE MOCKUP */}
          <div className="dash" aria-label="Zerrow sorting emails in real time">
            <div className="dash__chrome">
              <span className="dash__lights" aria-hidden="true">
                <i></i>
                <i></i>
                <i></i>
              </span>
              <span className="dash__label">Zerrow · Live telemetry</span>
              <span className="dash__chip">CH-01 · Routing</span>
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
                <div className="dash__row dash__row--keep">
                  <span className="dash__folder">Inbox</span>
                  <span className="dash__meta">Alex Chen · re: Thursday's demo</span>
                  <span className="dash__tag dash__tag--keep">kept for you</span>
                </div>
              </div>
              <div className="dash__focus">
                <div className="dash__ring">
                  99%
                  <span className="dash__satellite" aria-hidden="true"></span>
                </div>
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

        <div className="orbit-line" aria-hidden="true">
          <span></span>
        </div>

        {/* FLIGHT SYSTEMS — FEATURES */}
        <section className="section" id="features">
          <header className="sect-head">
            <div className="sect-kicker">Flight systems</div>
            <h2 className="sect-title">
              Built for people who'd rather <em>not</em> live in their inbox.
            </h2>
            <p className="sect-lede">
              Every system on board is calibrated to one objective: keep the inbox at zero without
              making you babysit it.
            </p>
          </header>

          <div className="cards">
            <article className="card">
              <div className="card__sys">SYS-01 · Guidance</div>
              <h3 className="card__title">Folders you define, in plain English</h3>
              <p className="card__body">
                Tell Zerrow what belongs in each folder — receipts from Stripe, cold pitches, client
                invites. Deterministic rules fire first, AI handles the judgment calls. No regex
                required.
              </p>
            </article>
            <article className="card">
              <div className="card__sys">SYS-02 · Propulsion</div>
              <h3 className="card__title">Real-time sorting as mail arrives</h3>
              <p className="card__body">
                Zerrow listens to Gmail's push events. New mail is read, summarized, and filed
                within seconds — long before you open the app, on every device.
              </p>
            </article>
            <article className="card">
              <div className="card__sys">SYS-03 · Comms</div>
              <h3 className="card__title">AI summaries and suggested replies</h3>
              <p className="card__body">
                Every email gets a one-line summary so you can scan the day in a minute. Need to
                respond? Zerrow drafts a concise, on-tone reply you review and send.
              </p>
            </article>
            <article className="card">
              <div className="card__sys">SYS-04 · Flight recorder</div>
              <h3 className="card__title">A mission log for every decision</h3>
              <p className="card__body">
                The Rule activity log records why each email went where it did — which rule fired,
                what the AI decided, and at what confidence. No black boxes on this ship.
              </p>
            </article>
            <article className="card">
              <div className="card__sys">SYS-05 · Life support</div>
              <h3 className="card__title">Human mail never gets lost</h3>
              <p className="card__body">
                Surface rules pull personal messages back to the inbox even when a folder claims
                them, overrides pin trusted senders, and the calendar guard keeps real contacts out
                of the cold-pitch bin.
              </p>
            </article>
            <article className="card">
              <div className="card__sys">SYS-06 · Autopilot</div>
              <h3 className="card__title">Learns from your moves</h3>
              <p className="card__body">
                Drag an email into a different folder and Zerrow updates that folder's profile.
                Added a new folder? Reanalyze any message and it reroutes against your latest rules.
              </p>
            </article>
          </div>
        </section>

        <div className="orbit-line" aria-hidden="true">
          <span></span>
        </div>

        {/* BEYOND THE INBOX */}
        <section className="section" id="beyond">
          <header className="sect-head">
            <div className="sect-kicker">Beyond the inbox</div>
            <h2 className="sect-title">
              The rest of the <em>crew</em>.
            </h2>
            <p className="sect-lede">
              Email is the mission — but Zerrow keeps the whole ship in order while it's at it.
            </p>
          </header>

          <div className="duo">
            <article className="duo__panel">
              <div className="card__sys">MOD-01 · Crew manifest</div>
              <h3 className="duo__title">Contacts that maintain themselves</h3>
              <p className="duo__body">
                Zerrow builds rich contact cards from your mail: AI-written bios, automatic company
                groups, duplicate detection, and signature scanning that fills in phone numbers and
                titles — synced with iPhone and Google contacts.
              </p>
              <ul className="duo__list">
                <li>AI bios &amp; relationship summaries</li>
                <li>Duplicate detection with one-tap merge</li>
                <li>Smart company &amp; role groups</li>
                <li>iPhone (CardDAV) + Google sync</li>
              </ul>
            </article>
            <article className="duo__panel">
              <div className="card__sys">MOD-02 · Hull integrity</div>
              <h3 className="duo__title">Built like a vault</h3>
              <p className="duo__body">
                Your mail is yours. Zerrow encrypts email content, summaries, and contact details at
                rest, connects through Google OAuth with least-privilege scopes, and scopes every
                row of data to your account alone.
              </p>
              <ul className="duo__list">
                <li>Content encrypted at rest</li>
                <li>Google OAuth — no passwords stored</li>
                <li>Row-level security on every table</li>
                <li>Disconnect &amp; purge any time</li>
              </ul>
            </article>
          </div>
        </section>

        <div className="orbit-line" aria-hidden="true">
          <span></span>
        </div>

        {/* LAUNCH SEQUENCE — HOW IT WORKS */}
        <section className="section" id="how">
          <header className="sect-head">
            <div className="sect-kicker">Launch sequence</div>
            <h2 className="sect-title">Three steps to inbox zero. Then it keeps itself there.</h2>
            <p className="sect-lede">
              Sign on, describe your folders, hand over the controls. Zerrow flies the rest of the
              mission.
            </p>
          </header>

          <div className="steps">
            <div className="step">
              <div className="step__num">T−3</div>
              <h3 className="step__title">Connect Gmail</h3>
              <p className="step__body">
                Sign in with Google. Zerrow connects to your existing Gmail account using OAuth — no
                password, no migration.
              </p>
            </div>
            <div className="step">
              <div className="step__num">T−2</div>
              <h3 className="step__title">Describe your folders</h3>
              <p className="step__body">
                Create a folder and write a one-line rule in plain English. Zerrow learns the rest
                from a handful of examples.
              </p>
            </div>
            <div className="step">
              <div className="step__num">T−1</div>
              <h3 className="step__title">Open a clean inbox</h3>
              <p className="step__body">
                Newsletters land in Newsletters. Receipts land in Receipts. Your inbox shows what's
                left — the email that actually wants you.
              </p>
            </div>
          </div>
        </section>

        <div className="orbit-line" aria-hidden="true">
          <span></span>
        </div>

        {/* FAQ */}
        <section className="section" id="faq">
          <header className="sect-head">
            <div className="sect-kicker">Pre-flight checks</div>
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
                Sensitive content is <b>encrypted at rest</b>, everything is{" "}
                <b>scoped to your account</b>, and you can disconnect Gmail at any time from
                Settings.
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
                single message — and the <b>Rule activity log</b> shows exactly why each decision
                was made.
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
                Review flight systems
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
              <span>Mission clock</span>
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
    </div>
  );
}
