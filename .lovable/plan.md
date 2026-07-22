## Make company bucket rows taller on mobile

In `src/components/contacts/CompanyBucketHeader.tsx`, bump the mobile-only sizing (desktop stays compact):

- Container padding: `py-3` → `py-4` on mobile, keep `sm:py-1.5`.
- Company logo: `size={22}` → render `28` on mobile, `22` on desktop (via a `useIsMobile`-style check, or pass responsive size prop; simplest: wrap logo in a responsive `<div>` with two `<CompanyLogo>`s hidden/shown, OR pass `size={window.matchMedia` — cleanest is a small `useMediaQuery('(min-width: 640px)')` hook to pick 22 vs 28).
- Company name label: `text-[11px]` → `text-[13px]` on mobile, `sm:text-[11px]`.
- Meta (domain · count): `text-[11px]` → `text-xs` on mobile, `sm:text-[11px]`.
- Open + chevron buttons: `h-6 w-6` → `h-8 w-8` on mobile, `sm:h-6 sm:w-6`; icons `h-4/h-3.5` → `h-5` on mobile, `sm:h-3.5/sm:h-4`.

Result: company rows on mobile visually match the taller contact rows; desktop layout unchanged.
