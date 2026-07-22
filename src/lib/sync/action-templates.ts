// Outbound-action templating (rules upgrade, task 8). Pure and
// whitelist-only: templates may reference exactly the tokens below —
// anything else is left as literal text, so a template can never reach
// into arbitrary email fields, env vars, or prototype internals.
//
// Bounds (ReDoS/DoS invariant): templates are capped at
// MAX_TEMPLATE_LEN before rendering and the rendered output is capped
// again after substitution; token replacement is a single linear pass
// with a non-backtracking pattern.

export const MAX_TEMPLATE_LEN = 4000;
/** Longest slice of email-derived text a single token may inject. */
const MAX_TOKEN_VALUE_LEN = 300;

export type TemplateEmail = {
  from_name: string | null;
  from_addr: string | null;
  subject: string | null;
  body_text: string | null;
  received_at: string | null;
};

function firstLineOf(body: string | null): string {
  for (const line of (body ?? "").split(/\r?\n/)) {
    const t = line.trim();
    if (t) return t;
  }
  return "";
}

function shortDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** Whitelisted token → value. Missing data falls back to a sensible
 * neutral string instead of leaking the raw token into the email. */
function tokenValue(token: string, email: TemplateEmail): string | null {
  switch (token) {
    case "from_name":
      return email.from_name?.trim() || email.from_addr || "there";
    case "first_name": {
      const name = email.from_name?.trim() || "";
      return name.split(/\s+/)[0] || email.from_addr || "there";
    }
    case "subject":
      return email.subject?.trim() || "(no subject)";
    case "received_at:short":
      return shortDate(email.received_at);
    case "first_line":
      return firstLineOf(email.body_text);
    default:
      return null; // not whitelisted — leave the literal text alone
  }
}

/** Render a template against an email. Unknown tokens stay literal;
 * whitelisted tokens with missing data use their fallback. Output is
 * hard-capped at MAX_TEMPLATE_LEN. */
export function renderTemplate(template: string, email: TemplateEmail): string {
  const capped = template.slice(0, MAX_TEMPLATE_LEN);
  const rendered = capped.replace(/\{\{\s*([a-z_]+(?::[a-z]+)?)\s*\}\}/g, (match, token) => {
    const value = tokenValue(token, email);
    if (value === null) return match;
    return value.slice(0, MAX_TOKEN_VALUE_LEN);
  });
  return rendered.slice(0, MAX_TEMPLATE_LEN);
}
