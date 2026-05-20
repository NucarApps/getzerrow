## Problem

In the email reader, HTML email bodies render dim/grey on the dark theme — text like "Daily Sales Report" is nearly invisible. Cause: email HTML ships with inline `color:` styles authored for a white background (e.g. dark grey on white). When dropped onto Zerrow's dark surface those colors stay dark and disappear.

`prose-invert` doesn't help because Tailwind Typography only re-colors elements without explicit inline styles; sender-set inline colors win.

## Fix

In `src/routes/_authenticated/index.tsx` `Reader`, render the HTML email on a light surface so sender colors look the way they were designed — same approach Gmail/Apple Mail dark modes use for HTML emails.

- For `email.body_html`: wrap in a rounded container with `bg-white text-neutral-900` and isolate it (`color-scheme: light`), so inline dark-on-white styles read correctly. Constrain images with `max-w-full h-auto`.
- For `email.body_text` (plain text): keep current dark-theme rendering but bump from `text-sm` to use `text-foreground` explicitly (it already does via inheritance; no change needed beyond removing `prose-invert` from this branch since there's no HTML to style).

Other small contrast nits visible in the screenshot, fixed in the same pass:
- Sender line (`from_name`/`from_addr`): change `text-muted-foreground` parent to keep the email address legible — leave as-is, it's fine on closer look.
- No layout or logic changes.

## Out of scope

- No changes to the list view, sidebar, or settings.
- No changes to design tokens or global theme.
