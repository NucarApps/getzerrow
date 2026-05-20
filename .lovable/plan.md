# Fix: email HTML leaking styles into the app chrome

## Problem

In `src/routes/_authenticated/inbox.tsx` (lines 881–886), the selected email's HTML is injected directly into the page via `dangerouslySetInnerHTML`:

```tsx
<div
  className="... [&_*]:max-w-full [&_a]:text-blue-600 [&_img]:h-auto [&_img]:max-w-full"
  dangerouslySetInnerHTML={{ __html: email.body_html }}
/>
```

Marketing / school / digest emails (like the Dover-Sherborn ParentSquare one in the screenshot) ship `<style>` blocks with **global selectors** — e.g. `h1 { font-size: 96px }`, `img { width: 100% !important }`, `body { font-family: ... }`. Because the email is rendered inline in the same document, those rules cascade onto the sidebar and header — that's why the "Zerrow" wordmark and the message subject blow up to hero-banner size when you open this email.

Tailwind's `[&_*]:max-w-full` only constrains descendants of the wrapper; it can't stop a `<style>` tag inside the email from targeting `h1`, `img`, `body`, etc. globally. There is also a small XSS surface for the same reason (inline `<script>` blocks would execute in the app's origin).

## Fix

Render the email body inside a sandboxed `<iframe srcDoc={...} sandbox="allow-popups allow-popups-to-escape-sandbox">` instead of inlining the HTML. That:

- Gives the email its own document, so its `<style>` rules can't touch the app.
- Disables scripts and same-origin access via `sandbox`.
- Keeps links clickable (`allow-popups` opens them in a new tab; we'll also inject a `<base target="_blank">` so anchors don't try to navigate the iframe itself).

### Changes (scope: presentation only, single file)

`src/routes/_authenticated/inbox.tsx`

1. Add a small `EmailBodyFrame` component (same file, above the message-pane component) that:
   - Builds `srcDoc` by wrapping `email.body_html` with `<!doctype html><html><head><base target="_blank"><meta charset="utf-8"><style>html,body{margin:0;padding:16px;background:#fff;color:#111;font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;} img{max-width:100%;height:auto;} a{color:#2563eb;}</style></head><body>…</body></html>`.
   - Renders `<iframe srcDoc={…} sandbox="allow-popups allow-popups-to-escape-sandbox" className="w-full rounded-lg bg-white" />`.
   - Auto-sizes height: on `iframe.onLoad`, read `contentDocument.documentElement.scrollHeight` and set the iframe's `style.height` (with a small `ResizeObserver` on the inner body so emails that load images later grow correctly). Cap at something sane (e.g. `min(scrollHeight, 4000)`).

2. Replace the inline `<div dangerouslySetInnerHTML=… />` (lines 881–886) with `<EmailBodyFrame html={email.body_html} />`. Keep the `<pre>` fallback for `body_text`.

No changes to data fetching, sync, AI summarization, sidebar, or styles elsewhere. No DB or server-function changes.

## Out of scope

- Sanitizing email HTML (e.g. DOMPurify) — the iframe sandbox already neutralizes the practical risks here. Can be added later if we want defense-in-depth.
- Reworking the reply composer, attachments, or any sidebar/header behavior.
- Changing how `body_html` is stored.
