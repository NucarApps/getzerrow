## Right-click: strip folder label, don't route to Inbox

### Current behavior

Right-click → **Just <sender>** / **Anyone @domain** shows two items:
1. *Future emails only* → adds an `inbox_overrides` row so future mail from that sender bypasses folders.
2. *Future + move past emails to Inbox* → adds the same override **and** strips the current folder label from past emails (it doesn't actually add the `INBOX` label in Gmail — the label is misleading).

### What you want

The second item should just remove the folder label from past matching emails — no Inbox routing, no future-mail override.

### Changes

**`src/routes/_authenticated/index.tsx`** (both submenus, sender + domain — lines 299-311 and 335-347):

Replace the second `ContextMenuItem` so it:
- Labels itself **"Remove folder label from past emails"** (and the domain variant: same wording).
- Calls a new server fn `stripFolderLabelPast` (see below) with `value` + `match_type` — NOT `addInboxOverride`.
- Invalidates `["emails"]` and `["emails-summary"]` only (no `["inbox-overrides"]` since we no longer touch overrides).
- Toast: *"Removed folder label from N past email(s)"*.

Keep the *Future emails only* item unchanged.

**`src/lib/gmail.functions.ts`** — add a new server fn:

```ts
export const stripFolderLabelPast = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { value: string; match_type: "email" | "domain" }) =>
    z.object({
      value: z.string().min(1).max(320),
      match_type: z.enum(["email", "domain"]),
    }).parse(d),
  )
  .handler(async ({ data, context }) => { /* see below */ });
```

Body reuses the existing "strip label" logic from `addInboxOverride` (lines 1161-1217) verbatim, but:
- Does NOT insert into `inbox_overrides`.
- Sets `classified_by: "manual_strip"` and `classification_reason: "Right-click: removed folder label"` (so the row is no longer attributed to a global-exclude rule that doesn't exist).
- Same Gmail `modifyMessage(..., [], [oldLabel])` call and same concurrency=5 worker pattern.
- Returns `{ stripped_count }`.

### Out of scope
- No change to *Future emails only* item.
- No change to `addInboxOverride` itself — it stays available for the first item.
- No change to folder-classifier logic (`classified_by: "manual_strip"` is just a label string; nothing branches on it).
- No UI for re-classifying stripped emails back into folders.
