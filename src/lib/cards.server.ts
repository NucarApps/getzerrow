// Server-only helpers for vCard generation and sending business cards via Gmail.
import { getAccessToken } from "./google-oauth.server";

export type CardData = {
  name: string | null;
  title: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  linkedin: string | null;
  twitter: string | null;
  tagline: string | null;
  handle: string;
  address_line1?: string | null;
  address_line2?: string | null;
  city?: string | null;
  region?: string | null;
  postal_code?: string | null;
  country?: string | null;
  avatar_url?: string | null;
  cover_url?: string | null;
  theme?: string | null;
};

function esc(s: string | null | undefined): string {
  if (!s) return "";
  return s.replace(/\\/g, "\\\\").replace(/,/g, "\\,").replace(/;/g, "\\;").replace(/\n/g, "\\n");
}

export function buildVCard(c: CardData, publicUrl?: string): string {
  const lines: string[] = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `FN:${esc(c.name || c.email || c.handle)}`,
  ];
  if (c.name) {
    const parts = c.name.split(/\s+/);
    const last = parts.length > 1 ? parts.slice(-1)[0] : "";
    const first = parts.length > 1 ? parts.slice(0, -1).join(" ") : c.name;
    lines.push(`N:${esc(last)};${esc(first)};;;`);
  }
  if (c.title) lines.push(`TITLE:${esc(c.title)}`);
  if (c.company) lines.push(`ORG:${esc(c.company)}`);
  if (c.email) lines.push(`EMAIL;TYPE=INTERNET:${esc(c.email)}`);
  if (c.phone) lines.push(`TEL;TYPE=CELL:${esc(c.phone)}`);
  if (c.website) lines.push(`URL:${esc(c.website)}`);
  if (c.linkedin) lines.push(`URL;TYPE=LinkedIn:${esc(c.linkedin)}`);
  if (c.twitter) lines.push(`URL;TYPE=Twitter:${esc(c.twitter)}`);
  if (c.tagline) lines.push(`NOTE:${esc(c.tagline)}`);
  const street = [c.address_line1, c.address_line2].filter(Boolean).join(", ");
  if (street || c.city || c.region || c.postal_code || c.country) {
    // vCard ADR: ;;street;city;region;postal_code;country
    lines.push(
      `ADR;TYPE=WORK:;;${esc(street)};${esc(c.city ?? "")};${esc(c.region ?? "")};${esc(c.postal_code ?? "")};${esc(c.country ?? "")}`,
    );
  }
  if (publicUrl) lines.push(`URL;TYPE=Zerrow:${esc(publicUrl)}`);
  lines.push("END:VCARD");
  return lines.join("\r\n");
}

/** Send the user's business card to a recipient via their Gmail account, with vCard attachment. */
export async function sendCardEmail(args: {
  accountId: string;
  fromEmail: string;
  toEmail: string;
  card: CardData;
  publicUrl: string;
}) {
  const token = await getAccessToken(args.accountId);
  const vcf = buildVCard(args.card, args.publicUrl);
  const vcfFilename = `${(args.card.name || args.card.handle).replace(/[^\w-]+/g, "_")}.vcf`;

  const subject = `${args.card.name || args.card.email || "My card"} — contact card`;
  const greeting = args.card.name
    ? `Hi,\n\nHere's my contact info.`
    : "Hi, here's my contact info.";
  const sigLines = [
    args.card.name,
    args.card.title && args.card.company
      ? `${args.card.title}, ${args.card.company}`
      : args.card.title || args.card.company,
    args.card.phone,
    args.card.email,
  ]
    .filter(Boolean)
    .join("\n");

  const textBody = `${greeting}

${sigLines}

View / save my card: ${args.publicUrl}

(.vcf attached — open it on your phone to add me to contacts.)`;

  const htmlBody = renderCardEmailHtml({
    card: args.card,
    intro: greeting,
    cta: { url: args.publicUrl, label: "View / save my card" },
    attachmentNote: "A .vcf file is attached - open it on your phone to add me to contacts.",
    footerNote: "Sent with Zerrow",
  });

  const boundaryAlt = `alt_${Math.random().toString(36).slice(2)}`;
  const boundaryMixed = `mix_${Math.random().toString(36).slice(2)}`;
  const vcfB64 = Buffer.from(vcf, "utf-8").toString("base64");

  const rfc822 = [
    `From: ${args.fromEmail}`,
    `To: ${args.toEmail}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundaryMixed}"`,
    "",
    `--${boundaryMixed}`,
    `Content-Type: multipart/alternative; boundary="${boundaryAlt}"`,
    "",
    `--${boundaryAlt}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 7bit",
    "",
    textBody,
    "",
    `--${boundaryAlt}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: 7bit",
    "",
    htmlBody,
    "",
    `--${boundaryAlt}--`,
    "",
    `--${boundaryMixed}`,
    `Content-Type: text/vcard; name="${vcfFilename}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${vcfFilename}"`,
    "",
    vcfB64.replace(/(.{76})/g, "$1\r\n"),
    "",
    `--${boundaryMixed}--`,
    "",
  ].join("\r\n");

  const raw = Buffer.from(rfc822)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Gmail send failed (${res.status}): ${t.slice(0, 300)}`);
  }
  return res.json();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Branded card email (HTML). Everything is table-based with inline styles so it
// renders in Gmail / Apple Mail / Outlook. Glyphs are numeric HTML entities so
// the transmitted body stays ASCII (the MIME part is declared 7bit).
// ---------------------------------------------------------------------------

type EmailTheme = { from: string; to: string; accent: string; accentText: string };

/** Concrete hex mirror of CARD_THEMES (Tailwind classes can't be used in email). */
const THEME_EMAIL_COLORS: Record<string, EmailTheme> = {
  default: { from: "#6366f1", to: "#818cf8", accent: "#4f46e5", accentText: "#ffffff" },
  sunset: { from: "#f97316", to: "#9333ea", accent: "#f97316", accentText: "#ffffff" },
  ocean: { from: "#06b6d4", to: "#4338ca", accent: "#2563eb", accentText: "#ffffff" },
  forest: { from: "#10b981", to: "#0f766e", accent: "#059669", accentText: "#ffffff" },
  noir: { from: "#3f3f46", to: "#000000", accent: "#18181b", accentText: "#ffffff" },
  rose: { from: "#fb7185", to: "#c026d3", accent: "#f43f5e", accentText: "#ffffff" },
  amber: { from: "#fbbf24", to: "#ef4444", accent: "#f59e0b", accentText: "#111111" },
  mono: { from: "#d4d4d4", to: "#a3a3a3", accent: "#111111", accentText: "#ffffff" },
};

function getEmailTheme(id?: string | null): EmailTheme {
  return THEME_EMAIL_COLORS[id ?? "default"] ?? THEME_EMAIL_COLORS.default;
}

function getInitials(name?: string | null, fallback?: string | null): string {
  const src = (name || fallback || "?").trim();
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const FONT_STACK =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function cardRow(glyph: string, valueHtml: string): string {
  return `<tr>
    <td width="26" style="width:26px;padding:6px 0;vertical-align:top;font-size:15px;line-height:20px;color:#6b7280">${glyph}</td>
    <td style="padding:6px 0;vertical-align:top;font-size:14px;line-height:20px;color:#111827">${valueHtml}</td>
  </tr>`;
}

type CardEmailInput = {
  card: {
    name: string | null;
    title: string | null;
    company: string | null;
    email: string | null;
    phone: string | null;
    website: string | null;
    linkedin?: string | null;
    twitter?: string | null;
    tagline?: string | null;
    avatar_url?: string | null;
    theme?: string | null;
  };
  /** Paragraph shown above the card (greeting / note). Plain text; newlines become <br>. */
  intro?: string | null;
  /** Prominent themed button, e.g. "View / save my card". Omit for none. */
  cta?: { url: string; label: string } | null;
  /** Small grey line about the .vcf attachment. */
  attachmentNote: string;
  /** Quiet footer line, e.g. "Sent with Zerrow". */
  footerNote: string;
  /** Optional address, rendered as its own row. */
  addressLines?: string[];
};

/** Render the shared branded card-email HTML used by both send paths. */
function renderCardEmailHtml(opts: CardEmailInput): string {
  const { card } = opts;
  const theme = getEmailTheme(card.theme);
  const displayName = card.name || card.email || "Contact";
  const subtitle =
    card.title && card.company
      ? `${card.title} &middot; ${card.company}`
      : card.title || card.company || "";

  const avatar = card.avatar_url
    ? `<img src="${escapeHtml(card.avatar_url)}" width="88" height="88" alt="${escapeHtml(displayName)}" style="display:block;width:88px;height:88px;border-radius:50%;border:4px solid #ffffff;object-fit:cover" />`
    : `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-radius:50%;border:4px solid #ffffff;background-color:${theme.accent}"><tr><td align="center" valign="middle" width="88" height="88" style="width:88px;height:88px;font-family:${FONT_STACK};font-size:30px;font-weight:700;color:${theme.accentText}">${escapeHtml(getInitials(card.name, card.email))}</td></tr></table>`;

  const rows: string[] = [];
  if (card.email)
    rows.push(
      cardRow(
        "&#9993;",
        `<a href="mailto:${escapeHtml(card.email)}" style="color:#111827;text-decoration:none">${escapeHtml(card.email)}</a>`,
      ),
    );
  if (card.phone)
    rows.push(
      cardRow(
        "&#128222;",
        `<a href="tel:${escapeHtml(card.phone.replace(/[^\d+]/g, ""))}" style="color:#111827;text-decoration:none">${escapeHtml(card.phone)}</a>`,
      ),
    );
  if (card.website)
    rows.push(
      cardRow(
        "&#127760;",
        `<a href="${escapeHtml(card.website)}" style="color:${theme.accent};text-decoration:none">${escapeHtml(card.website)}</a>`,
      ),
    );
  if (card.linkedin)
    rows.push(
      cardRow(
        "&#128279;",
        `<a href="${escapeHtml(card.linkedin)}" style="color:${theme.accent};text-decoration:none">LinkedIn</a>`,
      ),
    );
  if (card.twitter)
    rows.push(
      cardRow(
        "&#128038;",
        `<a href="${escapeHtml(card.twitter)}" style="color:${theme.accent};text-decoration:none">Twitter / X</a>`,
      ),
    );
  if (opts.addressLines && opts.addressLines.length > 0)
    rows.push(cardRow("&#128205;", escapeHtml(opts.addressLines.join(", "))));

  const cta = opts.cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px auto 0"><tr><td align="center" bgcolor="${theme.accent}" style="border-radius:10px"><a href="${escapeHtml(opts.cta.url)}" style="display:inline-block;padding:12px 28px;font-family:${FONT_STACK};font-size:15px;font-weight:600;color:${theme.accentText};text-decoration:none;border-radius:10px">${escapeHtml(opts.cta.label)}</a></td></tr></table>`
    : "";

  const introHtml = opts.intro?.trim()
    ? `<tr><td style="padding:0 4px 20px;font-family:${FONT_STACK};font-size:15px;line-height:22px;color:#374151">${escapeHtml(opts.intro.trim()).replace(/\n/g, "<br>")}</td></tr>`
    : "";

  return `<div style="margin:0;padding:0;background-color:#f3f4f6">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f3f4f6">
    <tr><td align="center" style="padding:32px 16px">
      <table role="presentation" width="440" cellpadding="0" cellspacing="0" border="0" style="width:440px;max-width:440px;font-family:${FONT_STACK}">
        ${introHtml}
        <tr><td>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e5e7eb">
            <tr><td height="96" bgcolor="${theme.from}" style="height:96px;background-color:${theme.from};background-image:linear-gradient(135deg,${theme.from},${theme.to})">&nbsp;</td></tr>
            <tr><td align="center" style="padding:0 24px 24px">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:-52px"><tr><td align="center">${avatar}</td></tr></table>
              <p style="margin:16px 0 0;font-size:22px;line-height:26px;font-weight:700;color:#111827">${escapeHtml(displayName)}</p>
              ${subtitle ? `<p style="margin:4px 0 0;font-size:14px;line-height:20px;color:#6b7280">${subtitle}</p>` : ""}
              ${card.tagline ? `<p style="margin:12px 0 0;font-size:14px;line-height:20px;font-style:italic;color:#4b5563">&ldquo;${escapeHtml(card.tagline)}&rdquo;</p>` : ""}
              ${rows.length > 0 ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0 0;text-align:left">${rows.join("")}</table>` : ""}
              ${cta}
            </td></tr>
          </table>
        </td></tr>
        <tr><td align="center" style="padding:16px 8px 0">
          <p style="margin:0;font-size:12px;line-height:18px;color:#9ca3af">${escapeHtml(opts.attachmentNote)}</p>
          <p style="margin:8px 0 0;font-size:11px;line-height:16px;color:#c4c4c4">${escapeHtml(opts.footerNote)}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</div>`;
}



export type ContactShareData = {
  name: string | null;
  title: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  linkedin: string | null;
  twitter: string | null;
  address_line1?: string | null;
  address_line2?: string | null;
  city?: string | null;
  region?: string | null;
  postal_code?: string | null;
  country?: string | null;
};

function formatAddressLines(c: {
  address_line1?: string | null;
  address_line2?: string | null;
  city?: string | null;
  region?: string | null;
  postal_code?: string | null;
  country?: string | null;
}): string[] {
  const lines: string[] = [];
  if (c.address_line1) lines.push(c.address_line1);
  if (c.address_line2) lines.push(c.address_line2);
  const cityLine = [c.city, c.region, c.postal_code].filter(Boolean).join(", ");
  if (cityLine) lines.push(cityLine);
  if (c.country) lines.push(c.country);
  return lines;
}

/** Share a saved contact with someone else via the user's Gmail account. Includes a .vcf attachment. */
export async function sendContactShareEmail(args: {
  accountId: string;
  fromEmail: string;
  toEmail: string;
  contact: ContactShareData;
  note?: string | null;
}) {
  const token = await getAccessToken(args.accountId);
  const c = args.contact;
  const cardData: CardData = {
    name: c.name,
    title: c.title,
    company: c.company,
    email: c.email,
    phone: c.phone,
    website: c.website,
    linkedin: c.linkedin,
    twitter: c.twitter,
    tagline: null,
    handle: (c.name || c.email || "contact").toLowerCase().replace(/[^\w-]+/g, "-"),
    address_line1: c.address_line1 ?? null,
    address_line2: c.address_line2 ?? null,
    city: c.city ?? null,
    region: c.region ?? null,
    postal_code: c.postal_code ?? null,
    country: c.country ?? null,
  };
  const vcf = buildVCard(cardData);
  const vcfFilename = `${(c.name || c.email || "contact").replace(/[^\w-]+/g, "_")}.vcf`;

  const displayName = c.name || c.email || "a contact";
  const subject = `Contact: ${displayName}`;
  const noteBlock = args.note?.trim() ? `${args.note.trim()}\n\n` : "";

  const addressLines = formatAddressLines(c);
  const sigLines = [
    c.name,
    c.title && c.company ? `${c.title}, ${c.company}` : c.title || c.company,
    c.phone,
    c.email,
    c.website,
    ...addressLines,
  ]
    .filter(Boolean)
    .join("\n");

  const textBody = `${noteBlock}I'm sharing ${displayName}'s contact info with you.

${sigLines}

(.vcf attached — open it on your phone to save them to contacts.)

— Shared from Zerrow`;

  const addressRow =
    addressLines.length > 0
      ? `<tr><td style="padding:2px 8px;color:#666;font-size:12px;vertical-align:top">Address</td><td style="padding:2px 8px;white-space:pre-line">${escapeHtml(addressLines.join("\n"))}</td></tr>`
      : "";

  const htmlBody = `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#111;line-height:1.5">
    ${args.note?.trim() ? `<p style="white-space:pre-wrap">${escapeHtml(args.note.trim())}</p>` : ""}
    <p>I'm sharing <strong>${escapeHtml(displayName)}</strong>'s contact info with you.</p>
    <table style="border-collapse:collapse;margin:16px 0">
      ${c.name ? `<tr><td style="padding:2px 8px;color:#666;font-size:12px">Name</td><td style="padding:2px 8px"><strong>${escapeHtml(c.name)}</strong></td></tr>` : ""}
      ${c.title ? `<tr><td style="padding:2px 8px;color:#666;font-size:12px">Title</td><td style="padding:2px 8px">${escapeHtml(c.title)}</td></tr>` : ""}
      ${c.company ? `<tr><td style="padding:2px 8px;color:#666;font-size:12px">Company</td><td style="padding:2px 8px">${escapeHtml(c.company)}</td></tr>` : ""}
      ${c.phone ? `<tr><td style="padding:2px 8px;color:#666;font-size:12px">Phone</td><td style="padding:2px 8px">${escapeHtml(c.phone)}</td></tr>` : ""}
      ${c.email ? `<tr><td style="padding:2px 8px;color:#666;font-size:12px">Email</td><td style="padding:2px 8px"><a href="mailto:${escapeHtml(c.email)}">${escapeHtml(c.email)}</a></td></tr>` : ""}
      ${c.website ? `<tr><td style="padding:2px 8px;color:#666;font-size:12px">Website</td><td style="padding:2px 8px"><a href="${escapeHtml(c.website)}">${escapeHtml(c.website)}</a></td></tr>` : ""}
      ${c.linkedin ? `<tr><td style="padding:2px 8px;color:#666;font-size:12px">LinkedIn</td><td style="padding:2px 8px"><a href="${escapeHtml(c.linkedin)}">${escapeHtml(c.linkedin)}</a></td></tr>` : ""}
      ${c.twitter ? `<tr><td style="padding:2px 8px;color:#666;font-size:12px">Twitter / X</td><td style="padding:2px 8px"><a href="${escapeHtml(c.twitter)}">${escapeHtml(c.twitter)}</a></td></tr>` : ""}
      ${addressRow}
    </table>
    <p style="color:#888;font-size:12px">A .vcf file is attached — open it on your phone to add them to contacts.</p>
    <p style="color:#aaa;font-size:11px">Shared from Zerrow</p>
  </div>`;

  const boundaryAlt = `alt_${Math.random().toString(36).slice(2)}`;
  const boundaryMixed = `mix_${Math.random().toString(36).slice(2)}`;
  const vcfB64 = Buffer.from(vcf, "utf-8").toString("base64");

  const rfc822 = [
    `From: ${args.fromEmail}`,
    `To: ${args.toEmail}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundaryMixed}"`,
    "",
    `--${boundaryMixed}`,
    `Content-Type: multipart/alternative; boundary="${boundaryAlt}"`,
    "",
    `--${boundaryAlt}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 7bit",
    "",
    textBody,
    "",
    `--${boundaryAlt}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: 7bit",
    "",
    htmlBody,
    "",
    `--${boundaryAlt}--`,
    "",
    `--${boundaryMixed}`,
    `Content-Type: text/vcard; name="${vcfFilename}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${vcfFilename}"`,
    "",
    vcfB64.replace(/(.{76})/g, "$1\r\n"),
    "",
    `--${boundaryMixed}--`,
    "",
  ].join("\r\n");

  const raw = Buffer.from(rfc822)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Gmail send failed (${res.status}): ${t.slice(0, 300)}`);
  }
  return res.json();
}
