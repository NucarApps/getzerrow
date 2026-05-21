## Problem

On `/settings`, the tab strip renders as a wide light-grey block with only the "Accounts" pill highlighted. The other two triggers ("Inbox filters", "Activity") sit inside the strip but their muted-foreground text on the muted background creates that awkward grey slab in the screenshot.

Root cause: `src/components/ui/tabs.tsx` `TabsList` uses the default shadcn styling — `bg-muted p-1 rounded-lg` with active trigger `bg-background shadow`. On the Zerrow deep-space palette, `--muted` is a low-contrast near-background grey that reads as a floating grey rectangle rather than a tab container.

## Fix

Scope the change to the Settings page only (don't touch the global `TabsList` primitive — other surfaces may rely on the filled pill look).

In `src/routes/_authenticated/settings.tsx`, override the `TabsList` className with an underline-style strip that fits the dark editorial aesthetic:

- Remove the muted background and pill padding by passing `className="bg-transparent p-0 h-auto gap-6 border-b border-border rounded-none w-full justify-start"` on `<TabsList>`.
- Override each `<TabsTrigger>` with `className="bg-transparent rounded-none px-0 pb-3 pt-0 border-b-2 border-transparent text-muted-foreground data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:border-primary data-[state=active]:shadow-none"` so the active tab is marked by an orange underline instead of a filled pill.

Result: a clean underlined tab strip (Accounts · Inbox filters · Activity) with the active tab underlined in the NASA-orange primary, no grey slab.

## Files

- `src/routes/_authenticated/settings.tsx` — add `className` overrides on the existing `<TabsList>` and three `<TabsTrigger>` elements. No other files change.
