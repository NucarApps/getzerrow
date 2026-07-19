## Problem
On mobile (402px) the company detail → Labels tab has two issues:

1. **The Add-label input is offscreen.** It renders below the existing label chips; when there are many chips, mobile users only see the chip grid at the top, which looks like the "search people" list from the neighboring People tab. The input to create a new label is buried below the fold.
2. **The tab bar wraps.** `TabsList` uses `flex-wrap`, so on narrow screens "Labels" drops to a second row with a smaller effective tap target, making it easy to miss.

## Fix
Edit only `src/routes/_authenticated/contacts.companies.$companyId.tsx`.

### 1. Move the Add-label input to the top of the Labels section
Inside `CompanyLabelsSection`, render the new-label input row **above** the chip list (with a small "Create new label" label). Keep the existing chip grid and toggle behavior below. Empty-state message stays under the input.

### 2. Make the tab bar horizontally scrollable on mobile
Change the `TabsList` on the company page from `flex w-full flex-wrap` to a single-row, horizontally scrollable strip on small screens:

- `flex w-full gap-1 overflow-x-auto whitespace-nowrap` on mobile
- keep wrapping only from `sm:` up (or leave as single row on all sizes — no wrap needed for 5 short labels)
- add `flex-shrink-0` to each `TabsTrigger` so they don't compress

This keeps all five tabs (People, Details, Domains, Logo, Labels) on one line and equally tappable on 402px.

### Out of scope
- No server-fn or schema changes.
- No changes to People, Details, Domains, or Logo tabs.
- No changes to color, rules, or auto-subgroup behavior.
