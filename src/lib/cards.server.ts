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
  const greeting = args.card.name ? `Hi,\n\nHere's my contact info.` : "Hi, here's my contact info.";
  const sigLines = [
    args.card.name,
    args.card.title && args.card.company ? `${args.card.title}, ${args.card.company}` : (args.card.title || args.card.company),
    args.card.phone,
    args.card.email,
  ].filter(Boolean).join("\n");

  const textBody = `${greeting}

${sigLines}

View / save my card: ${args.publicUrl}

(.vcf attached — open it on your phone to add me to contacts.)`;

  const htmlBody = `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#111;line-height:1.5">
    <p>${greeting.replace(/\n/g, "<br>")}</p>
    <table style="border-collapse:collapse;margin:16px 0">
      ${args.card.name ? `<tr><td style="padding:2px 8px;color:#666;font-size:12px">Name</td><td style="padding:2px 8px"><strong>${escapeHtml(args.card.name)}</strong></td></tr>` : ""}
      ${args.card.title ? `<tr><td style="padding:2px 8px;color:#666;font-size:12px">Title</td><td style="padding:2px 8px">${escapeHtml(args.card.title)}</td></tr>` : ""}
      ${args.card.company ? `<tr><td style="padding:2px 8px;color:#666;font-size:12px">Company</td><td style="padding:2px 8px">${escapeHtml(args.card.company)}</td></tr>` : ""}
      ${args.card.phone ? `<tr><td style="padding:2px 8px;color:#666;font-size:12px">Phone</td><td style="padding:2px 8px">${escapeHtml(args.card.phone)}</td></tr>` : ""}
      ${args.card.email ? `<tr><td style="padding:2px 8px;color:#666;font-size:12px">Email</td><td style="padding:2px 8px">${escapeHtml(args.card.email)}</td></tr>` : ""}
      ${args.card.website ? `<tr><td style="padding:2px 8px;color:#666;font-size:12px">Website</td><td style="padding:2px 8px"><a href="${escapeHtml(args.card.website)}">${escapeHtml(args.card.website)}</a></td></tr>` : ""}
    </table>
    <p><a href="${escapeHtml(args.publicUrl)}" style="display:inline-block;background:#111;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">View / save my card</a></p>
    <p style="color:#888;font-size:12px">A .vcf file is attached — open it on your phone to add me to contacts.</p>
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

  const raw = Buffer.from(rfc822).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

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
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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
  address_line1?: string | null; address_line2?: string | null;
  city?: string | null; region?: string | null;
  postal_code?: string | null; country?: string | null;
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
    name: c.name, title: c.title, company: c.company, email: c.email,
    phone: c.phone, website: c.website, linkedin: c.linkedin, twitter: c.twitter,
    tagline: null, handle: (c.name || c.email || "contact").toLowerCase().replace(/[^\w-]+/g, "-"),
  };
  const vcf = buildVCard(cardData);
  const vcfFilename = `${(c.name || c.email || "contact").replace(/[^\w-]+/g, "_")}.vcf`;

  const displayName = c.name || c.email || "a contact";
  const subject = `Contact: ${displayName}`;
  const noteBlock = args.note?.trim() ? `${args.note.trim()}\n\n` : "";

  const addressLines = formatAddressLines(c);
  const sigLines = [
    c.name, c.title && c.company ? `${c.title}, ${c.company}` : (c.title || c.company),
    c.phone, c.email, c.website,
    ...addressLines,
  ].filter(Boolean).join("\n");

  const textBody = `${noteBlock}I'm sharing ${displayName}'s contact info with you.

${sigLines}

(.vcf attached — open it on your phone to save them to contacts.)

— Shared from Zerrow`;

  const addressRow = addressLines.length > 0
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

  const raw = Buffer.from(rfc822).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

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
