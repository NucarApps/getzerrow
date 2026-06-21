import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { useMissionTelemetry } from "@/components/landing/useMissionTelemetry";
import zerrowLogo from "@/assets/zerrow-logo-v2.png";
import shipUrl from "@/assets/zerrow-ship.png";

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
      {/* TOP STATUS BAR */}
      <div className="status-bar">
        <div className="status-bar__inner">
          <div className="status-cluster">
            <span className="status-dot" aria-hidden="true"></span>
            <span className="status-label">MISSION CONTROL</span>
            <span className="status-sep">·</span>
            <span className="status-id">ZRW-001</span>
          </div>
          <div className="status-cluster">
            <span className="status-label muted">SIGNAL</span>
            <span className="status-bars" aria-hidden="true">
              <i></i>
              <i></i>
              <i></i>
              <i></i>
              <i></i>
            </span>
            <span className="status-sep">·</span>
            <span className="status-label muted">UPLINK</span>
            <span className="status-val" id="uplink-val">
              98.4%
            </span>
          </div>
          <div className="status-cluster">
            <span className="status-label muted">MET</span>
            <span className="status-val" id="met-val">
              T+00:00:00
            </span>
            <span className="status-sep">·</span>
            <span className="status-pill">NOMINAL</span>
          </div>
        </div>
      </div>

      {/* NAV */}
      <header className="nav">
        <a href="#" className="brand">
          <span
            className="brand__mark"
            aria-hidden="true"
            style={{ background: "transparent", border: "none" }}
          >
            <img
              src={zerrowLogo}
              alt="Zerrow"
              style={{ height: 56, width: "auto", display: "block" }}
            />
          </span>
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
            Connect Gmail <span aria-hidden="true">→</span>
          </Link>
        </div>
      </header>

      <main>
        {/* HERO */}
        <section className="hero" data-screen-label="01 Hero">
          <div className="hero__left">
            <div className="hero__eyebrow">
              <span>For Gmail</span>
              <span>·</span>
              <span>
                powered by <b>AI</b>
              </span>
            </div>
            <h1 className="hero__title">
              An inbox
              <br />
              that <em>sorts</em>
              <br />
              <span className="stroke">itself.</span>
            </h1>
            <p className="hero__sub">
              Zerrow reads every new email and files it into the folders you actually use —{" "}
              <b>newsletters, invoices, cold pitches, calendar invites</b> — so the only thing left
              in your inbox is what deserves your attention.
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

            <div className="hero__stats">
              <div className="hero__stat">
                <div className="hero__stat__num">
                  <span id="stat-routed">142</span>
                </div>
                <div className="hero__stat__lbl">Messages routed · last 24h</div>
              </div>
              <div className="hero__stat">
                <div className="hero__stat__num">
                  99.<span>2</span>%
                </div>
                <div className="hero__stat__lbl">Classification accuracy</div>
              </div>
              <div className="hero__stat">
                <div className="hero__stat__num">
                  <span>2.4</span>s
                </div>
                <div className="hero__stat__lbl">Median sort time</div>
              </div>
            </div>
          </div>

          {/* LAUNCHPAD */}
          <aside className="launchpad" aria-label="Mission control launchpad visualization">
            <div className="launchpad__head">
              <div className="left">
                <span className="launchpad__lights">
                  <i className="green"></i>
                  <i className="amber"></i>
                  <i className="red"></i>
                </span>
                <span>
                  ZRW-001 · <b>LAUNCHPAD</b>
                </span>
              </div>
              <div className="right">
                <span>CAM 04</span>
                <span>·</span>
                <span id="hero-clock">T-00:00:03</span>
              </div>
            </div>

            <div className="launchpad__viewport" id="launchpad-viewport">
              <div className="viewport-grid"></div>
              <div className="viewport-crosshair"></div>

              {/* Downrange tracking view — revealed after liftoff */}
              <div className="tracking" aria-hidden="true">
                <div className="tracking__sky">
                  <i style={{ left: "8%", top: "18%" }}></i>
                  <i style={{ left: "22%", top: "42%" }}></i>
                  <i style={{ left: "34%", top: "12%" }}></i>
                  <i style={{ left: "47%", top: "28%" }}></i>
                  <i style={{ left: "58%", top: "8%" }}></i>
                  <i style={{ left: "66%", top: "36%" }}></i>
                  <i style={{ left: "74%", top: "20%" }}></i>
                  <i style={{ left: "86%", top: "32%" }}></i>
                  <i style={{ left: "92%", top: "14%" }}></i>
                  <i style={{ left: "14%", top: "60%" }}></i>
                </div>
                <div className="tracking__earth"></div>
                <svg
                  className="tracking__arc"
                  viewBox="0 0 600 400"
                  preserveAspectRatio="xMidYMid slice"
                >
                  <defs>
                    <linearGradient id="arcGrad" x1="0" y1="1" x2="1" y2="0">
                      <stop offset="0%" stopColor="#ff5a2e" stopOpacity=".15" />
                      <stop offset="50%" stopColor="#ff8a3d" stopOpacity=".9" />
                      <stop offset="100%" stopColor="#ffd089" stopOpacity=".4" />
                    </linearGradient>
                    <path id="arcPathLanding" d="M 30 370 Q 300 -120 570 90" />
                  </defs>
                  <use href="#arcPathLanding" className="tracking__arc-ghost" fill="none" />
                  <use
                    href="#arcPathLanding"
                    className="tracking__arc-live"
                    fill="none"
                    stroke="url(#arcGrad)"
                  />
                  <g className="tracking__rocket">
                    <g transform="rotate(90) scale(0.09) translate(-60 -118)">
                      <image
                        href={shipUrl}
                        x="10"
                        y="0"
                        width="100"
                        height="240"
                        preserveAspectRatio="xMidYMid meet"
                      />
                    </g>
                    <animateMotion
                      dur="28s"
                      repeatCount="indefinite"
                      rotate="auto"
                      keyPoints="0;1"
                      keyTimes="0;1"
                      calcMode="spline"
                      keySplines="0.4 0 0.6 1"
                    >
                      <mpath href="#arcPathLanding" />
                    </animateMotion>
                  </g>
                </svg>

                <div className="tracking__hud tracking__hud--tl">
                  <span className="tracking__dot"></span>
                  TRACKING · DOWNRANGE
                </div>
                <div className="tracking__hud tracking__hud--br">
                  <div className="tele-row">
                    <span className="k">Downrange</span>
                    <span className="v orange" id="t-downrange">
                      0 km
                    </span>
                  </div>
                  <div className="tele-row">
                    <span className="k">Apogee</span>
                    <span className="v" id="t-apogee">
                      0.0 km
                    </span>
                  </div>
                </div>
                <div className="tracking__hud tracking__hud--tr" id="t-attitude-hud">
                  <div className="attitude">
                    <svg viewBox="0 0 40 40" className="attitude__ring">
                      <circle
                        cx="20"
                        cy="20"
                        r="17"
                        fill="none"
                        stroke="rgba(255,138,61,.35)"
                        strokeWidth="1"
                      />
                      <line
                        x1="3"
                        y1="20"
                        x2="37"
                        y2="20"
                        stroke="rgba(255,138,61,.25)"
                        strokeWidth="1"
                        strokeDasharray="2 2"
                      />
                    </svg>
                    <div className="attitude__needle" id="t-attitude-needle"></div>
                  </div>
                  <div className="tele-row">
                    <span className="k">Pitch</span>
                    <span className="v orange" id="t-pitch">
                      90°
                    </span>
                  </div>
                </div>
              </div>

              <div className="viewport-counter">
                <div className="viewport-counter__lbl">Inbox · Unread</div>
                <div className="viewport-counter__num" id="inbox-count">
                  1,247
                </div>
                <div className="viewport-counter__delta" id="inbox-delta">
                  ▼ routing…
                </div>
              </div>

              <div className="viewport-telemetry">
                <div className="tele-row">
                  <span className="k">Altitude</span>
                  <span className="v" id="t-alt">
                    000.0 km
                  </span>
                </div>
                <div className="tele-row">
                  <span className="k">Velocity</span>
                  <span className="v" id="t-vel">
                    0,000 m/s
                  </span>
                </div>
                <div className="tele-row">
                  <span className="k">Thrust</span>
                  <span className="v green" id="t-thrust">
                    96.1%
                  </span>
                </div>
                <div className="tele-row">
                  <span className="k">Fuel</span>
                  <span className="v amber" id="t-fuel">
                    100%
                  </span>
                </div>
                <div className="tele-row">
                  <span className="k">G-force</span>
                  <span className="v" id="t-g">
                    1.0 g
                  </span>
                </div>
                <div className="tele-row">
                  <span className="k">Heading</span>
                  <span className="v orange" id="t-hdg">
                    000.0°
                  </span>
                </div>
              </div>

              <div className="smoke">
                <i></i>
                <i></i>
                <i></i>
                <i></i>
                <i></i>
                <i></i>
                <i></i>
                <i></i>
                <i></i>
                <i></i>
              </div>
              <div className="sparks">
                <b></b>
                <b></b>
                <b></b>
                <b></b>
                <b></b>
              </div>

              <div className="rocket-wrap" id="rocket">
                <svg className="rocket" viewBox="0 0 120 280" xmlns="http://www.w3.org/2000/svg">
                  <image
                    href={shipUrl}
                    x="10"
                    y="0"
                    width="100"
                    height="260"
                    preserveAspectRatio="xMidYMid meet"
                  />
                </svg>

                <div className="exhaust">
                  <div className="exhaust__halo"></div>
                  <div className="exhaust__core"></div>
                  <div className="exhaust__jet"></div>
                </div>
              </div>

              <div className="pad-base"></div>
            </div>

            <div className="launchpad__foot">
              <div className="foot-cell">
                <div className="k">Routed today</div>
                <div className="v">
                  <span id="foot-routed">142</span>
                </div>
              </div>
              <div className="foot-cell">
                <div className="k">Folders</div>
                <div className="v">
                  8 <small>active</small>
                </div>
              </div>
              <div className="foot-cell">
                <div className="k">Latency</div>
                <div className="v green" id="foot-lat">
                  2.4<small>s</small>
                </div>
              </div>
              <div className="foot-cell">
                <div className="k">Status</div>
                <div className="v orange">SORTING</div>
              </div>
            </div>
          </aside>
        </section>

        {/* FEATURES */}
        <section className="section" id="features" data-screen-label="02 Features">
          <header className="section-head">
            <div className="t-minus">
              <span className="t-minus__label">Stage 03 · Payload</span>
              <span className="t-minus__big">
                <span>T</span>−3
              </span>
              <span>Six instruments. One mission.</span>
            </div>
            <div>
              <div className="section-kicker">FEATURES / PAYLOAD MANIFEST</div>
              <h2 className="section-title">
                Built for people who'd rather <em>not</em> live in their inbox.
              </h2>
              <p className="section-lede">
                Every onboard system is calibrated to one objective: keep the inbox at zero without
                making you babysit it.
              </p>
            </div>
          </header>

          <div className="features-grid">
            <article className="feature">
              <div className="feature__num">01 / Folder profiles</div>
              <h3 className="feature__title">Folders you define, in plain English</h3>
              <p className="feature__body">
                Tell Zerrow what belongs in each folder — <code>receipts from Stripe</code>,{" "}
                <code>cold sales pitches</code>, <code>calendar invites from clients</code>. The AI
                handles the rest. No filter rules, no regex.
              </p>
            </article>
            <article className="feature">
              <div className="feature__num">02 / Realtime routing</div>
              <h3 className="feature__title">Real-time sorting as mail arrives</h3>
              <p className="feature__body">
                Zerrow listens to Gmail's push events. New mail is read, summarized, and moved
                within seconds — long before you open the app.
              </p>
            </article>
            <article className="feature">
              <div className="feature__num">03 / Auto-summary</div>
              <h3 className="feature__title">One-sentence AI summaries</h3>
              <p className="feature__body">
                Every email gets a single-line summary so you can scan the day in a minute. Open
                only the ones that need a real reply.
              </p>
            </article>
            <article className="feature">
              <div className="feature__num">04 / Self-tuning</div>
              <h3 className="feature__title">Learns from your moves</h3>
              <p className="feature__body">
                Drag an email into a different folder and Zerrow updates that folder's profile. The
                next misclassification of the same kind doesn't happen.
              </p>
            </article>
            <article className="feature">
              <div className="feature__num">05 / Reanalyze</div>
              <h3 className="feature__title">Reanalyze on demand</h3>
              <p className="feature__body">
                Added a new folder? Hit <code>Reanalyze</code> on any email and Zerrow reroutes it
                against your latest rules — no full re-sync required.
              </p>
            </article>
            <article className="feature">
              <div className="feature__num">06 / Drafts</div>
              <h3 className="feature__title">Suggested replies, when you want them</h3>
              <p className="feature__body">
                Zerrow drafts a concise, on-tone reply for any thread. You stay in control — review,
                edit, and send from the same view.
              </p>
            </article>
          </div>
        </section>

        {/* HOW IT WORKS */}
        <section className="section" id="how" data-screen-label="03 How it works">
          <header className="section-head">
            <div className="t-minus">
              <span className="t-minus__label">Stage 02 · Flight Sequence</span>
              <span className="t-minus__big">
                <span>T</span>−2
              </span>
              <span>Three steps to inbox zero.</span>
            </div>
            <div>
              <div className="section-kicker">FLIGHT SEQUENCE / SOP</div>
              <h2 className="section-title">
                Three steps to inbox zero.
                <br />
                Then it keeps itself there.
              </h2>
              <p className="section-lede">
                Sign on, describe your folders, hand over the controls. Zerrow takes it from there.
              </p>
            </div>
          </header>

          <div className="flight-sequence">
            <div className="step">
              <div className="step__head">
                <span className="step__dot">01</span>
                <span>Step · Pre-flight</span>
              </div>
              <h3 className="step__title">Connect Gmail</h3>
              <p className="step__body">
                Sign in with Google. Zerrow connects to your existing Gmail account using OAuth — no
                password, no migration.
              </p>
              <div className="step__demo">
                <div className="ln">
                  <span>
                    OAuth handshake <b>· accepted</b>
                  </span>
                </div>
                <div className="ln">
                  <span>
                    Reading labels <b>· 12 found</b>
                  </span>
                </div>
                <div className="ln ok">
                  <span>
                    Connected to <b>you@gmail.com</b> ✓
                  </span>
                </div>
              </div>
            </div>
            <div className="step">
              <div className="step__head">
                <span className="step__dot">02</span>
                <span>Step · Configure</span>
              </div>
              <h3 className="step__title">Describe your folders</h3>
              <p className="step__body">
                Create a folder and write a one-line rule in plain English. Zerrow learns the rest
                from a handful of examples.
              </p>
              <div className="step__demo">
                <div className="ln">
                  <span>
                    + <b>Receipts</b> &nbsp;"any payment confirmation"
                  </span>
                </div>
                <div className="ln">
                  <span>
                    + <b>Cold pitches</b> &nbsp;"unsolicited sales emails"
                  </span>
                </div>
                <div className="ln ok">
                  <span>8 folders trained ✓</span>
                </div>
              </div>
            </div>
            <div className="step">
              <div className="step__head">
                <span className="step__dot">03</span>
                <span>Step · Liftoff</span>
              </div>
              <h3 className="step__title">Open a clean inbox</h3>
              <p className="step__body">
                Newsletters land in Newsletters. Receipts land in Receipts. Your inbox shows what's
                left — the email that actually wants you.
              </p>
              <div className="step__demo">
                <div className="ln">
                  <span>Routed 142 messages overnight</span>
                </div>
                <div className="ln">
                  <span>
                    Inbox now at <b>0 unread</b>
                  </span>
                </div>
                <div className="ln ok">
                  <span>Mission · NOMINAL ✓</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section className="section" id="faq" data-screen-label="04 FAQ">
          <header className="section-head">
            <div className="t-minus">
              <span className="t-minus__label">Stage 01 · Briefing</span>
              <span className="t-minus__big">
                <span>T</span>−1
              </span>
              <span>Mission briefing.</span>
            </div>
            <div>
              <div className="section-kicker">MISSION BRIEFING / FAQ</div>
              <h2 className="section-title">
                Questions, <em>answered</em>.
              </h2>
              <p className="section-lede">
                Everything you need to know before you hand Zerrow the keys to your inbox.
              </p>
            </div>
          </header>

          <div className="faq">
            <details className="faq-item" open>
              <summary>
                <span className="faq-num">Q.01</span>
                <span>Does Zerrow store my emails?</span>
                <span className="faq-toggle">+</span>
              </summary>
              <div className="faq-body">
                Zerrow syncs message metadata and content so it can classify and summarize.
                Everything is <b>scoped to your account</b>, and you can disconnect Gmail at any
                time from Settings.
              </div>
            </details>
            <details className="faq-item">
              <summary>
                <span className="faq-num">Q.02</span>
                <span>Will it move emails in Gmail itself?</span>
                <span className="faq-toggle">+</span>
              </summary>
              <div className="faq-body">
                Yes — when Zerrow files an email into a folder, it applies the matching Gmail label
                so your <b>phone, web, and other clients stay in sync</b>.
              </div>
            </details>
            <details className="faq-item">
              <summary>
                <span className="faq-num">Q.03</span>
                <span>What if it gets it wrong?</span>
                <span className="faq-toggle">+</span>
              </summary>
              <div className="faq-body">
                Move the email to the correct folder and Zerrow learns from it. The next time a
                similar email arrives, it routes correctly. You can also hit <b>Reanalyze</b> on any
                single message.
              </div>
            </details>
            <details className="faq-item">
              <summary>
                <span className="faq-num">Q.04</span>
                <span>Which mail providers are supported?</span>
                <span className="faq-toggle">+</span>
              </summary>
              <div className="faq-body">
                <b>Gmail and Google Workspace</b> today. Other providers may come later.
              </div>
            </details>
          </div>
        </section>

        {/* CTA */}
        <section className="section" id="cta" data-screen-label="05 CTA">
          <div className="liftoff">
            <div className="liftoff__kicker">T−00 · LIFTOFF</div>
            <h2 className="liftoff__title">
              Take your inbox <em>back</em>.
            </h2>
            <p className="liftoff__sub">
              Connect Gmail in 30 seconds. Zerrow does the rest. Email shouldn't be a job — and
              Zerrow is the assistant that finally treats it like one.
            </p>
            <div className="liftoff__cta">
              <Link className="btn btn--primary btn--lg" to="/login">
                Get started — it's free <span aria-hidden="true">↗</span>
              </Link>
              <a className="btn btn--ghost btn--lg" href="#features">
                Review payload
              </a>
            </div>
            <div className="liftoff__readout">
              <span>All systems</span>
              <b>● NOMINAL</b>
              <span>·</span>
              <span>Awaiting handshake</span>
            </div>
          </div>
        </section>

        {/* FOOTER */}
        <footer className="footer">
          <div className="footer__inner">
            <div>© 2026 Zerrow · An inbox that sorts itself</div>
            <div className="footer__trail">
              <span>●</span>
              <span>MISSION ELAPSED</span>
              <span id="footer-met">T+00:00:00</span>
            </div>
            <div className="footer__links">
              <a href="#features">Features</a>
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
