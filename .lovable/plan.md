## What I found

- Roberta’s contact is linked to company `Fred C. Church, Inc.` and has no personal stored `avatar_url` now.
- That company’s `companies.logo_url` is also empty, but Zerrow does have a saved logo choice for the company domain mapping: `assuredpartners.com` uses `fredcchurch.com` as the source logo.
- The current forced Google photo push only checks `contacts.avatar_url` and `companies.logo_url`, so it wrongly returns “no photo” even when a domain/company logo exists.
- The Google push worker only selects photo-dirty contacts with a stored `avatar_url`, so company-logo fallback photos never get pushed to Google even when the contact displays a logo in Zerrow/CardDAV.

## Plan

1. **Centralize photo resolution**
   - Add/reuse a server-side helper that resolves the effective photo bytes for a contact in this order:
     1. real contact photo (`avatar_url`)
     2. uploaded company logo (`companies.logo_url`)
     3. selected/company-domain logo (`company_logo_choices` + company domains)
   - Return enough metadata for logging and etag comparison, such as source and resolved logo domain.

2. **Fix “Sync to Google now”**
   - Update `pushContactPhotoToGoogleNow` so it checks the same effective photo resolver instead of only `avatar_url`/`logo_url`.
   - Roberta-style contacts should be marked dirty and synced when they have a company/domain logo, not told “No photo to sync”.

3. **Fix the Google photo push worker**
   - Include photo-dirty contacts even when `avatar_url` is null, as long as they have a linked company/domain logo.
   - During photo upload, load bytes from the effective photo resolver instead of only `loadContactPhotoBytes(avatar_url)`.
   - Store a stable `photo_etag` for fallback logos based on the resolved source/domain/hash so Google won’t be repushed every run.

4. **Improve trace logs**
   - Update photo push logs to include whether the photo came from contact photo, company upload, or company domain logo.
   - Keep the existing fields: contact id, company id, current photo etag, Google photo URL, and error.

5. **Add regression tests**
   - Cover the case where a contact has no `avatar_url`, company `logo_url` is null, but a domain/company logo choice exists.
   - Cover that this contact is included in photo-dirty Google push selection and does not get skipped as “no avatar”.

6. **Verify**
   - Run the focused photo/contact tests.
   - Re-check Roberta’s backend state after the code path change so the forced sync can push her effective company logo instead of no-oping.