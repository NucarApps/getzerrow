# Brighten read emails in the inbox list

## Problem
Read items in the inbox list look too dull because the whole row is dimmed via `opacity-70`. Unread vs read should still be obvious, but read rows should read clearly.

## Change
In `src/routes/_authenticated/inbox.tsx` (the list row around line 391):

- Remove `opacity-70` from the read state on the row container. Read rows then render at full brightness.
- Keep unread distinction via weight + a small accent dot (already font-semibold for sender on unread). Strengthen it so the difference is unambiguous without dimming:
  - Sender (line 394): unread stays `font-semibold text-foreground`; read becomes `font-medium text-foreground` (no muted color).
  - Subject line: unread `text-foreground`; read `text-foreground/85` (subtle, not dull).
  - Snippet (line 433): keep `text-muted-foreground` for both — the snippet was never the signal.
  - Add a 6px primary dot on the left of unread rows so unread is identifiable at a glance without relying on dimming.

## Result
Read rows are bright and legible. Unread rows pop via bold sender + colored dot, not via making read rows feel disabled.
