## Fix empty/short emails rendering as a big white box on mobile

Single file: `src/routes/_authenticated/inbox.tsx` → `EmailBodyFrame`.

### 1. Drop the artificial tall minimum height

Replace:
```ts
const minPx = Math.max(500, Math.round(window.innerHeight * 0.6));
```
with a small floor:
```ts
const MIN_PX = 60;
```
Use `MIN_PX` in both `resize()` and the iframe `minHeight` style. Short emails will render at their natural height instead of a 500–700 px white slab.

### 2. Fall back to text when `body_html` is effectively empty

Before mounting the iframe, strip tags/whitespace from `body_html`:
```ts
const hasVisibleHtml = (html ?? "")
  .replace(/<style[\s\S]*?<\/style>/gi, "")
  .replace(/<script[\s\S]*?<\/script>/gi, "")
  .replace(/<[^>]+>/g, "")
  .replace(/&nbsp;|\s/g, "")
  .length > 0;
```
At the render site (line ~1164):
```tsx
{email.body_html && hasVisibleHtml(email.body_html) ? (
  <EmailBodyFrame html={email.body_html} />
) : (
  <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-foreground">
    {email.body_text || email.snippet || ""}
  </pre>
)}
```
(Move `hasVisibleHtml` to module scope so both call sites can use it.)

### 3. Re-measure after a tick

iOS Safari sometimes reports `scrollHeight = 0` on the first `onLoad` for `srcDoc` iframes. After the existing `resize()` call, schedule a second resize on `requestAnimationFrame` and a third at `setTimeout(…, 250)` so late layout (web fonts, images) settles before we lock the height.

### Out of scope
- No styling changes elsewhere on the email view, no changes to list/sync.
