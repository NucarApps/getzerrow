import { useState } from "react";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import zerrowLogo from "@/assets/zerrow-logo-v2.png";
import zerrowShip from "@/assets/zerrow-ship.png";

export const Route = createFileRoute("/")({
  beforeLoad: async () => {
    const { data } = await supabase.auth.getSession();
    if (data.session) throw redirect({ to: "/inbox" });
  },
  head: () => ({
    meta: [
      { title: "Zerrow — Every email finds its planet" },
      {
        name: "description",
        content:
          "Zerrow is the cosmic sorting office for your Gmail. Newsletters, receipts, and cold pitches sort themselves onto the right planets — your inbox stays a quiet little home planet.",
      },
      { property: "og:title", content: "Zerrow — Every email finds its planet" },
      {
        property: "og:description",
        content:
          "The cosmic sorting office for your Gmail. Every email sorts itself onto the right planet — your inbox stays quiet.",
      },
      { property: "og:url", content: "https://getzerrow.com/" },
      { name: "twitter:title", content: "Zerrow — Every email finds its planet" },
      {
        name: "twitter:description",
        content:
          "The cosmic sorting office for your Gmail. Every email sorts itself onto the right planet — your inbox stays quiet.",
      },
    ],
    links: [
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&family=Instrument+Serif:ital@0;1&display=swap",
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
              name: "What if it lands on the wrong planet?",
              acceptedAnswer: {
                "@type": "Answer",
                text: "Drag the email to the right folder and Zerrow learns the route. Hit Reanalyze on any message, and the rule activity log shows exactly why each decision was made.",
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
  const [eaten, setEaten] = useState(4096);
  const [burping, setBurping] = useState(false);
  const burp = () => {
    if (burping) return;
    setEaten((e) => e + 1);
    setBurping(true);
    setTimeout(() => setBurping(false), 550);
  };

  return (
    <div className="landing">
      {/* DEEP-SPACE SKY — nebula, star drift, twinkles, shooting stars, flyby */}
      <div className="sky" aria-hidden="true">
        <div className="sky__base"></div>
        <div className="sky__nebula"></div>
        <div className="sky__band"></div>
        <div className="sky__stars sky__stars--far"></div>
        <div className="sky__stars sky__stars--mid"></div>
        <div className="sky__stars sky__stars--near"></div>
        <span
          className="tw"
          style={{ top: "14%", left: "22%", width: 3, height: 3, animationDuration: "3.2s" }}
        ></span>
        <span
          className="tw"
          style={{
            top: "22%",
            left: "44%",
            width: 2,
            height: 2,
            animationDuration: "4.4s",
            animationDelay: "1.8s",
          }}
        ></span>
        <span
          className="tw"
          style={{
            top: "52%",
            left: "88%",
            width: 3,
            height: 3,
            animationDuration: "3.5s",
            animationDelay: ".9s",
          }}
        ></span>
        <span
          className="tw tw--amber"
          style={{
            top: "72%",
            left: "34%",
            width: 2,
            height: 2,
            animationDuration: "5s",
            animationDelay: "2.4s",
          }}
        ></span>
        <span
          className="tw"
          style={{
            top: "90%",
            left: "14%",
            width: 2.5,
            height: 2.5,
            animationDuration: "4.2s",
            animationDelay: "3.1s",
          }}
        ></span>
        <span
          className="tw"
          style={{
            top: "44%",
            left: "6%",
            width: 2,
            height: 2,
            animationDuration: "3.8s",
            animationDelay: "1.4s",
          }}
        ></span>
        <span
          className="tw tw--amber"
          style={{
            top: "36%",
            left: "78%",
            width: 2.5,
            height: 2.5,
            animationDuration: "4.1s",
            animationDelay: "1.2s",
          }}
        ></span>
        <span
          className="tw"
          style={{
            top: "64%",
            left: "10%",
            width: 2.5,
            height: 2.5,
            animationDuration: "3.7s",
            animationDelay: "2s",
          }}
        ></span>
        <span
          className="tw"
          style={{
            top: "82%",
            left: "62%",
            width: 3,
            height: 3,
            animationDuration: "4.6s",
            animationDelay: ".6s",
          }}
        ></span>
        <span
          className="tw tw--orange"
          style={{
            top: "8%",
            left: "56%",
            width: 2,
            height: 2,
            animationDuration: "3.9s",
            animationDelay: "2.6s",
          }}
        ></span>
        <div className="shoot" style={{ top: "6%", left: -180, transform: "rotate(28deg)" }}>
          <span className="shoot__streak">
            <i></i>
            <i></i>
          </span>
        </div>
        <div
          className="shoot shoot--amber"
          style={{ top: "38%", left: -160, transform: "rotate(14deg)" }}
        >
          <span className="shoot__streak">
            <i></i>
            <i></i>
          </span>
        </div>
        <img className="sky__flyby" src={zerrowShip} alt="" />
      </div>

      {/* NAV */}
      <header className="nav">
        <a href="#top" className="brand">
          <img className="brand__logo" src={zerrowLogo} alt="Zerrow" />
        </a>
        <nav className="nav__links">
          <a href="#planets">The planets</a>
          <a href="#fieldguide">Field guide</a>
          <a href="#flightplan">Flight plan</a>
          <a href="#transmissions">Transmissions</a>
        </nav>
        <div className="nav__cta">
          <Link className="btn btn--ghost" to="/login">
            Sign in
          </Link>
          <Link className="btn btn--primary" to="/login">
            Hop aboard <span aria-hidden="true">→</span>
          </Link>
        </div>
      </header>

      <main>
        {/* HERO + ORBIT SYSTEM */}
        <section className="hero" id="top">
          <div className="kicker">The Zerrow system · pop. your email</div>
          <h1 className="hero__title">
            Every email finds <span className="accent">its planet.</span>
          </h1>
          <p className="hero__sub">
            Zerrow is the cosmic sorting office for your Gmail. Newsletters orbit Planet Newsletter.
            Receipts join the Receipt Ring. Cold pitches? <b>Straight into the black hole.</b> Your
            inbox stays a quiet little home planet.
          </p>
          <div className="hero__cta">
            <Link className="btn btn--primary btn--lg" to="/login">
              Connect Gmail — begin the voyage <span aria-hidden="true">→</span>
            </Link>
            <a className="btn btn--ghost btn--lg" href="#planets">
              Tour the planets
            </a>
          </div>
          <div className="hero__fineprint">Free to try · Uses your existing Gmail labels</div>

          <div className="orbit" aria-label="Emails orbiting into folder planets">
            <div className="orbit__sun"></div>
            <div className="orbit__sunring"></div>
            <img className="orbit__ship" src={zerrowShip} alt="" />
            <div className="orbit__homelbl">
              <span>Home · your inbox</span>
            </div>
            <div className="orbit__track orbit__track--inner"></div>
            <div className="orbit__track orbit__track--outer"></div>
            <div className="orbit__spin orbit__spin--inner">
              <div className="carrier carrier--inner carrier--top">
                <div className="planet planet--amber" style={{ width: 68, height: 68 }}></div>
                <div className="planet__lbl" style={{ color: "var(--amber)" }}>
                  Planet Newsletter
                </div>
              </div>
              <div className="carrier carrier--inner carrier--bottom">
                <div style={{ position: "relative", width: 60, height: 60 }}>
                  <div className="planet planet--grey" style={{ width: 60, height: 60 }}></div>
                  <div className="planet__ring" style={{ width: 96, height: 26 }}></div>
                </div>
                <div className="planet__lbl" style={{ color: "var(--muted-2)", marginTop: 10 }}>
                  The Receipt Ring
                </div>
              </div>
            </div>
            <div className="orbit__spin orbit__spin--outer">
              <div className="carrier carrier--outer carrier--right">
                <div className="planet planet--green" style={{ width: 52, height: 52 }}></div>
                <div className="planet__lbl" style={{ color: "var(--green)" }}>
                  Invite Isle
                </div>
              </div>
              <div className="carrier carrier--outer carrier--left">
                <button
                  type="button"
                  className={`bhole${burping ? " bhole--burp" : ""}`}
                  onClick={burp}
                  title="Feed me a cold pitch"
                  aria-label="Feed the black hole a cold pitch"
                  style={{ border: 0, padding: 0, background: "transparent", display: "block" }}
                >
                  <span className="bhole__glow"></span>
                  <span className="bhole__core"></span>
                </button>
                <div className="planet__lbl" style={{ color: "var(--orange)", marginTop: 12 }}>
                  The Black Hole
                  <br />
                  <small>cold pitches · {eaten.toLocaleString("en-US")} eaten</small>
                </div>
              </div>
            </div>
            <div className="orbit__spin orbit__spin--courier">
              <span className="mail">
                <i></i>
              </span>
            </div>
            <div className="orbit__spin orbit__spin--courier2">
              <span className="mail">
                <i></i>
              </span>
            </div>
            <div className="orbit__track orbit__track--courier"></div>
          </div>

          {/* STATS */}
          <div className="stats">
            <div className="stat">
              <div className="stat__num">1,248</div>
              <div className="stat__lbl">Deliveries since breakfast</div>
            </div>
            <div className="stat stat--orange">
              <div className="stat__num">99.2%</div>
              <div className="stat__lbl">Land on the right planet</div>
            </div>
            <div className="stat">
              <div className="stat__num">2.4s</div>
              <div className="stat__lbl">Average delivery time</div>
            </div>
          </div>
        </section>

        {/* TOUR THE SYSTEM — PLANET CARDS */}
        <section className="section" id="planets">
          <header className="sect-head">
            <div className="kicker">Tour the system</div>
            <h2 className="sect-title">
              You name the planets. <span className="accent">Zerrow flies the mail.</span>
            </h2>
            <p className="sect-lede">
              A folder is just a planet with a one-line description. Write it in plain English —
              Zerrow handles the gravity.
            </p>
          </header>

          <div className="pcards">
            <article className="pcard pcard--amber">
              <div className="pcard__icon pcard__icon--bob planet planet--amber"></div>
              <div>
                <div className="pcard__tag" style={{ color: "var(--amber)" }}>
                  Planet Newsletter
                </div>
                <h3>Where the digests go to be read on purpose</h3>
                <p>
                  "Anything with an unsubscribe link and good intentions." Every issue lands here
                  with a one-line AI summary, so Sunday-morning-you can catch up over coffee.
                </p>
              </div>
            </article>
            <article className="pcard pcard--grey">
              <div className="pcard__icon pcard__icon--bob" style={{ animationDuration: "6s" }}>
                <div className="planet planet--grey" style={{ width: 64, height: 64 }}></div>
                <div className="planet__ring" style={{ width: 100, height: 28 }}></div>
              </div>
              <div>
                <div className="pcard__tag" style={{ color: "var(--muted-2)" }}>
                  The Receipt Ring
                </div>
                <h3>Every invoice, orbiting in order</h3>
                <p>
                  Stripe receipts, subscription renewals, that thing you expensed. Filed instantly,
                  labeled in Gmail, and findable the day your accountant comes asking.
                </p>
              </div>
            </article>
            <article className="pcard pcard--orange">
              <div className="pcard__icon">
                <span className="bhole__glow" style={{ inset: -8 }}></span>
                <span
                  className="bhole__core"
                  style={{ inset: 4, boxShadow: "inset 0 0 16px rgba(0,0,0,.9)" }}
                ></span>
              </div>
              <div>
                <div className="pcard__tag" style={{ color: "var(--orange)" }}>
                  The Black Hole
                </div>
                <h3>Cold pitches check in. They don't check out.</h3>
                <p>
                  "Quick call this week?" No. Unsolicited outreach is detected and pulled past the
                  event horizon — while the calendar guard keeps real humans safely out of its
                  gravity.
                </p>
              </div>
            </article>
            <article className="pcard pcard--home">
              <div
                className="pcard__icon pcard__icon--bob planet planet--sun"
                style={{ animationDuration: "4.5s" }}
              ></div>
              <div>
                <div className="pcard__tag" style={{ color: "var(--orange)" }}>
                  Home · your inbox
                </div>
                <h3>Population: only mail that matters</h3>
                <p>
                  Surface rules pull personal messages home even when a planet claims them, and
                  trusted senders get a permanent visa. What's left is email from actual humans,
                  about actual things.
                </p>
              </div>
            </article>
          </div>

          <p className="pcards__note">
            Filed something wrong? Drag it to the right planet and Zerrow learns the route. Every
            decision is logged — <b>which rule fired, what the AI decided, at what confidence.</b>{" "}
            No mystery meteors.
          </p>
        </section>

        {/* FIELD GUIDE — CONTACTS + SECURITY */}
        <section className="section" id="fieldguide" style={{ paddingTop: 24 }}>
          <header className="sect-head">
            <div className="kicker">Field guide</div>
            <h2 className="sect-title" style={{ marginBottom: 0 }}>
              Life beyond <span className="accent">the mailbox.</span>
            </h2>
          </header>

          <div className="duo">
            <article className="duo__panel duo__panel--amber">
              <div className="duo__stars">
                <span
                  className="tw tw--amber"
                  style={{ top: 8, left: 6, width: 5, height: 5, animationDuration: "3s" }}
                ></span>
                <span
                  className="tw"
                  style={{
                    top: 34,
                    left: 44,
                    width: 4,
                    height: 4,
                    animationDuration: "4s",
                    animationDelay: "1s",
                  }}
                ></span>
                <span
                  className="tw"
                  style={{
                    top: 12,
                    left: 86,
                    width: 5,
                    height: 5,
                    animationDuration: "3.4s",
                    animationDelay: ".5s",
                  }}
                ></span>
                <span
                  className="tw tw--amber"
                  style={{
                    top: 58,
                    left: 98,
                    width: 4,
                    height: 4,
                    animationDuration: "4.4s",
                    animationDelay: "1.6s",
                  }}
                ></span>
                <span
                  className="tw"
                  style={{
                    top: 62,
                    left: 20,
                    width: 4,
                    height: 4,
                    animationDuration: "3.8s",
                    animationDelay: "2.2s",
                  }}
                ></span>
              </div>
              <div className="pcard__tag" style={{ color: "var(--amber)" }}>
                The constellation of contacts
              </div>
              <h3 className="duo__title">A crew roster that writes itself</h3>
              <p className="duo__body">
                Every email quietly polishes your address book. AI-written bios, automatic company
                groups, duplicate stars merged with one tap, and signature scanning that fills in
                phone numbers and titles while you sleep.
              </p>
              <ul className="duo__list duo__list--amber">
                <li>AI bios &amp; relationship summaries</li>
                <li>Duplicate detection, one-tap merge</li>
                <li>Smart company &amp; role groups</li>
                <li>Synced to iPhone (CardDAV) + Google</li>
              </ul>
            </article>
            <article className="duo__panel duo__panel--orange">
              <div className="pcard__tag" style={{ color: "var(--orange)" }}>
                The vault at the edge of space
              </div>
              <h3 className="duo__title">Your mail stays yours</h3>
              <p className="duo__body">
                Content, summaries, and contact details encrypted at rest. Google OAuth with
                least-privilege scopes — we never see a password. Every row of data sealed to your
                account, and one button to disconnect and purge it all.
              </p>
              <ul className="duo__list duo__list--orange">
                <li>Content encrypted at rest</li>
                <li>Google OAuth — no passwords stored</li>
                <li>Row-level security on every table</li>
                <li>Disconnect &amp; purge any time</li>
              </ul>
            </article>
          </div>
        </section>

        {/* FLIGHT PLAN — HOW IT WORKS */}
        <section className="section" id="flightplan">
          <header className="sect-head">
            <div className="kicker">Flight plan</div>
            <h2 className="sect-title">
              Three stops to <span className="accent">a quiet inbox.</span>
            </h2>
            <p className="sect-lede">
              Ninety seconds of setup, then the sorting office runs itself. Forever.
            </p>
          </header>

          <div className="steps">
            <svg
              className="steps__path"
              viewBox="0 0 600 20"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <path
                d="M0 14 Q150 -6 300 10 T600 6"
                fill="none"
                stroke="rgba(255,107,61,.4)"
                strokeWidth="1.5"
                strokeDasharray="6 8"
              />
            </svg>
            <div className="step">
              <div className="step__num step__num--sun">1</div>
              <h3 className="step__title">Board with Google</h3>
              <p className="step__body">
                OAuth, not passwords. Your Gmail stays exactly where it is — Zerrow just gets a jump
                seat.
              </p>
            </div>
            <div className="step">
              <div className="step__num step__num--amber">2</div>
              <h3 className="step__title">Chart your planets</h3>
              <p className="step__body">
                One plain-English line per folder. "Receipts and renewals." Done. Zerrow learns the
                rest from examples.
              </p>
            </div>
            <div className="step">
              <div className="step__num step__num--grey">3</div>
              <h3 className="step__title">Come home to quiet</h3>
              <p className="step__body">
                New mail sorts itself in seconds, labels sync everywhere, and your inbox holds only
                what matters.
              </p>
            </div>
          </div>
        </section>

        {/* TRANSMISSIONS — FAQ */}
        <section className="section" id="transmissions">
          <header className="sect-head">
            <div className="kicker">Incoming transmissions</div>
            <h2 className="sect-title" style={{ marginBottom: 0 }}>
              You asked. <span className="accent">Ground control answered.</span>
            </h2>
          </header>

          <div className="faq">
            <details className="faq-item" open>
              <summary>
                <span className="faq-tx">TX-01</span>
                <span className="faq-q">Does Zerrow store my emails?</span>
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
                <span className="faq-tx">TX-02</span>
                <span className="faq-q">Will it move emails in Gmail itself?</span>
                <span className="faq-toggle" aria-hidden="true">
                  +
                </span>
              </summary>
              <div className="faq-body">
                Yes — when Zerrow files an email onto a planet, it applies the matching Gmail label
                so your <b>phone, web, and other clients stay in sync</b>.
              </div>
            </details>
            <details className="faq-item">
              <summary>
                <span className="faq-tx">TX-03</span>
                <span className="faq-q">What if it lands on the wrong planet?</span>
                <span className="faq-toggle" aria-hidden="true">
                  +
                </span>
              </summary>
              <div className="faq-body">
                Drag the email to the right folder and Zerrow learns the route. Hit <b>Reanalyze</b>{" "}
                on any message, and the <b>rule activity log</b> shows exactly why each decision was
                made.
              </div>
            </details>
            <details className="faq-item">
              <summary>
                <span className="faq-tx">TX-04</span>
                <span className="faq-q">Which mail providers are supported?</span>
                <span className="faq-toggle" aria-hidden="true">
                  +
                </span>
              </summary>
              <div className="faq-body">
                <b>Gmail and Google Workspace</b> today. Other galaxies under consideration.
              </div>
            </details>
          </div>
        </section>

        {/* CTA */}
        <section className="section" style={{ paddingTop: 24, paddingBottom: 96 }}>
          <div className="cta__inner">
            <img className="cta__ship" src={zerrowShip} alt="" />
            <h2 className="cta__title">
              Give your inbox <span className="accent">a solar system.</span>
            </h2>
            <p className="cta__sub">
              Thirty seconds to connect Gmail. Then every email knows exactly where it lives — and
              so do you.
            </p>
            <div className="cta__actions">
              <Link className="btn btn--primary btn--lg" to="/login">
                Hop aboard — it's free <span aria-hidden="true">↗</span>
              </Link>
              <a className="btn btn--ghost btn--lg" href="#planets">
                Tour the planets again
              </a>
            </div>
          </div>
        </section>

        {/* FOOTER */}
        <footer className="footer">
          <div className="footer__inner">
            <div>© 2026 Zerrow · The cosmic sorting office</div>
            <div className="footer__status">
              <i aria-hidden="true"></i>
              <span>All planets reporting in</span>
            </div>
            <div className="footer__links">
              <a href="#planets">Features</a>
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
