## Changes to `src/components/contacts/CompanyBucketHeader.tsx`

1. **Uniform logo sizing on mobile**
   - Wrap the mobile `CompanyLogo` in a fixed `44x44` container with `overflow-hidden rounded-md` and `shrink-0`, and pass a consistent size so brand-image logos (Axalta, HC, Bettervantage, BlueOwl) and monogram fallbacks (Bell, Bentley) all render at the same visual footprint.
   - Ensure the inner `<img>`/monogram fills the box (`h-full w-full object-contain`) so square brand images no longer appear larger or smaller than monograms.

2. **Hide domain on mobile**
   - In the meta line, split domain and count: render `domain · aliasCount` only on `sm:` and up, keep the count visible on mobile.
   - Result on mobile: just `COMPANY NAME  {count}`; desktop unchanged.

No other files or behaviors change.