## Change

Normalize phone numbers in the two `phoneEntrySchema` definitions so saves are consistent and forgiving without loosening the character rules.

**Files:** `src/lib/contacts-helpers.server.ts`, `src/routes/api/mobile/contacts.ts` (both currently duplicate the schema).

**Normalization applied inside a `.transform()` before `.regex()`:**
1. Trim leading/trailing whitespace (already done — keep).
2. Collapse any inner run of whitespace (spaces, tabs, non-breaking spaces `\u00A0`) to a single ASCII space.
3. Leave every other character untouched, so extension separators `;`, `,`, `*`, `#`, `:`, and `x`/`X` round-trip verbatim (Apple/Google both use these).

**Validation after normalization** stays strict via the existing regex:
`/^[+\d\s().,#*;:x/A-Za-z-]{3,60}$/`
Anything outside that set (emoji, quotes, `<>`, `@`, etc.) still fails with "Invalid phone format".

**Shape:**
```ts
number: z
  .string()
  .transform((v) => v.replace(/[\s\u00A0]+/g, " ").trim())
  .pipe(z.string().min(3).max(60).regex(PHONE_NUMBER_RE, "Invalid phone format")),
```

Using `.transform().pipe(...)` (not `.trim().regex()`) so the normalized value is what the length + regex checks see AND what gets persisted downstream — no double-writing normalization logic in the callers.

**Tests:** add a small unit test next to `contacts-helpers.server.ts` covering:
- `"  800-225-1865 ;7160 "` → `"800-225-1865 ;7160"` and passes
- `"555\u00A0123\t4567"` → `"555 123 4567"` and passes
- `"+1 (415) 555-0100,,,123"` passes unchanged (after inner-space collapse)
- `"555-hello😀"` fails with "Invalid phone format"

No schema changes, no data migration — this only affects new writes.