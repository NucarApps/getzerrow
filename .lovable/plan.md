## Goal
When scanning a business card, retain the photo, cropped to just the card, and show it on the contact's detail page.

## Flow
1. User picks/captures a photo (existing).
2. New crop step appears before the AI review form:
   - Auto-detect the card's bounding rectangle on a downscaled canvas (grayscale → blur → Sobel edges → largest 4-corner contour). If detection succeeds, pre-fill an adjustable crop box; otherwise fall back to a centered default.
   - User can drag the 4 corners / edges to fine-tune, then "Confirm crop".
3. Cropped image (perspective-warped to a flat rectangle, JPEG ~85%) is:
   - sent to `scanCard` for AI extraction (replaces the raw upload, faster + cleaner)
   - uploaded to the `card-images` storage bucket under `<user_id>/<uuid>.jpg`
4. Public URL stored on the contact as `card_image_url`.
5. `ContactDetailView` shows a "Business card" section with the image (click to view full size).

## Data model
- Migration: `ALTER TABLE contacts ADD COLUMN card_image_url text;`
- `card-images` bucket already exists and is public — add storage RLS policies so authenticated users can insert/update/delete only under their own `<user_id>/` prefix (read stays public).

## Server functions (`src/lib/contacts.functions.ts`)
- `createContactFromScan`: accept optional `cardImageUrl`, persist to `contacts.card_image_url`.
- `updateContact`: accept optional `cardImageUrl` so users can remove/replace later.
- `getContact` / `listContacts`: include `card_image_url` (detail only needs it; list query left untouched).

## UI
- New `src/components/contacts/CardCropper.tsx`:
  - Canvas-based corner-draggable quad overlay on the source image.
  - `detectCardQuad(imageData)` helper using a lightweight Sobel + contour heuristic (pure TS, no deps).
  - `warpToRect(image, quad, outW, outH)` using canvas 2D with 2-triangle affine slices (good enough for near-rectangular cards; no extra libs).
  - Emits `{ croppedDataUrl, croppedBlob }`.
- `contacts.scan.tsx`:
  - Insert crop step between file pick and AI scan.
  - Upload cropped blob to `card-images` via the supabase client, get public URL, then call `scanCard` with the cropped data URL and pass `cardImageUrl` into `createContactFromScan`.
  - Show cropped preview in the review form.
- `ContactDetailView.tsx`:
  - New "Business card" block rendering `card_image_url` (rounded, max-h ~14rem, click opens lightbox dialog). Includes "Remove" button that clears the URL via `updateContact`.

## Validation / limits
- Cropped output capped at 1600px on the long edge, JPEG quality 0.85.
- `cardImageUrl` Zod: `z.string().url().max(500).optional().nullable()`.
- Hostname not validated (public bucket URL); URL format check only.

## Out of scope
- Replacing the avatar with the card image.
- List/thumbnail rendering.
- OCR confidence highlighting on the crop.
- Multiple card images per contact.

## Files
- new: `supabase/migrations/<ts>_contact_card_image.sql`
- new: `src/components/contacts/CardCropper.tsx`
- edit: `src/lib/contacts.functions.ts`, `src/routes/_authenticated/contacts.scan.tsx`, `src/components/contacts/ContactDetailView.tsx`
