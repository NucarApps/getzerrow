## Goal

Add a third option to the right-click "Always send to inbox" submenus so the user can apply the rule to **future and past emails** in one click — alongside the existing "Future emails only" and "Remove folder label from past emails".

## Changes — `src/routes/_authenticated/inbox.tsx`

In both `Just {from_addr}` and `Anyone @{domain}` submenus (around lines 469–553), add a new `ContextMenuItem` labeled **"Future and past emails"** between the two existing items.

Its handler does the same work as the two current items combined, in sequence:
1. Call `addOverrideFn({ value, match_type })` — adds the inbox override for future mail.
2. Optimistically remove matching rows from the cached email lists (same filter the strip handler uses).
3. Call `stripLabelFn({ value, match_type })` — strips folder labels from past matching mail.
4. Invalidate `["emails"]`, `["emails-summary"]`, `["inbox-overrides"]`.
5. Toast a combined message, e.g. `Added to inbox list · cleaned {n} past email(s)`.
6. On error, invalidate queries and toast the error.

Apply to both the email-address submenu and the domain submenu. No backend changes — both server functions (`addInboxOverride`, `stripFolderLabelPast`) already exist and accept the same input shape.

## Result

Right-click → Always send to inbox → Just {sender} (or Anyone @{domain}) now shows three options:
- Future emails only
- Future and past emails  ← new
- Remove folder label from past emails
