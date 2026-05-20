## Problem

When an email is classified by **Gmail label**, **filter**, or **domain rule** (not AI), `classifyParsedEmail` never calls the AI, so `ai_summary` stays `null`. Clicking **Reanalyze** runs the same path and again skips summarization, leaving the row with no yellow ✨ summary in the list. The user wants Reanalyze to **always** produce a summary when one is missing, even if the folder doesn't change.

## Fix

Add a tiny standalone summarizer and call it from `reanalyzeEmail` whenever the post-classification summary is empty.

### 1. `src/lib/ai.server.ts` — add `summarizeEmail`

New exported function next to `classifyEmail` (one short LLM call, plain text out, capped at 140 chars to match the existing column usage):

```ts
export async function summarizeEmail(email: {
  from_name: string;
  from_addr: string;
  subject: string;
  body_text: string;
  snippet: string;
}): Promise<string> {
  const { text } = await generateText({
    model: getModel("google/gemini-2.5-flash-lite"),
    prompt: `Write a single-sentence summary (max 140 chars) of this email — what it's about and what (if anything) the sender wants. No greetings, no preamble, no quotes.

From: ${email.from_name} <${email.from_addr}>
Subject: ${email.subject}

${(email.body_text || email.snippet || "").slice(0, 4000)}`,
  });
  return text.trim().replace(/^["']|["']$/g, "").slice(0, 140);
}
```

Use `flash-lite` since this is a quick one-line task; fall back silently on errors.

### 2. `src/lib/gmail.functions.ts` — `reanalyzeEmail` handler

After `classifyParsedEmail` returns, if `result.ai_summary` is empty AND we have body content to summarize, generate one and merge it into every update path:

```ts
const { summarizeEmail } = await import("./ai.server");

let summary = result.ai_summary || "";
if (!summary) {
  try {
    summary = await summarizeEmail({
      from_name: parsed.from_name,
      from_addr: parsed.from_addr,
      subject: parsed.subject,
      body_text: parsed.body_text,
      snippet: parsed.snippet,
    });
  } catch (e) {
    console.error("reanalyze summarize failed", e);
  }
}
```

Then thread `summary` (instead of `result.ai_summary`) into:
- the **noMatch + kept folder** early-return branch's `update({ ai_summary: summary || null })`
- the main `update({...})` block (replace `ai_summary: result.ai_summary || null` with `ai_summary: summary || null`)
- the `changed: true` and `changed: false` returns (no functional change, just consistency).

That way the yellow summary chip appears on the list row immediately after Reanalyze, regardless of whether the folder changed.

## Not changing

- Initial ingest path (`processGmailMessage`) — summaries on first arrival still only come from the AI classification path. We can extend this later if the user wants summaries on every inbound email, but it would mean an extra LLM call per email on sync.
- Classification logic / filters / labels / archived state.
- Schema.

## Verification

1. Open the **Cold Email** screenshot row, click Reanalyze.
2. Toast still says "Re-analyzed — no change" (or "kept" if AI returns NONE), but the row in the list now shows the ✨ yellow one-liner summary.
3. Open an email that *does* change folder on reanalyze — confirm the summary is also populated.
