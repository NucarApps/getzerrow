// Shared plumbing for the two Supabase Storage buckets that hold image bytes:
// `contact-photos` (a contact's avatar) and `company-logos` (a company's
// uploaded logo). Both modules independently defined identical copies of these
// three helpers.
//
// The per-bucket save/delete flows stay in their own modules — they differ in
// which table they update, which side-effects they trigger (Google dirty
// marking, CardDAV resync nonce, logo-hash recording), and their access model
// (contact photos are private and signed; company logos are public).

/** Max decoded bytes accepted for either bucket. iOS caps around 2 MB anyway. */
export const MAX_STORED_PHOTO_BYTES = 5 * 1024 * 1024;

/**
 * First 16 hex chars of the SHA-256 over `bytes`.
 *
 * Used as a filename suffix so the object key — and therefore the public URL —
 * changes whenever the picture actually changes. That doubles as a cache-buster
 * and as the etag compared during delta sync.
 */
export async function shortHash(bytes: Uint8Array): Promise<string> {
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

/** File extension for a stored image, defaulting to jpg for anything unknown. */
export function extForMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes("png")) return "png";
  if (m.includes("gif")) return "gif";
  if (m.includes("webp")) return "webp";
  return "jpg";
}

/**
 * Recover the in-bucket object key from a stored public URL, so a previous
 * object can be pruned after a replacement is committed.
 *
 * Returns null when the URL doesn't point into `bucket` — e.g. a remote avatar
 * we never uploaded — which callers treat as "nothing of ours to delete".
 */
export function pathToBucketKey(bucket: string, publicUrl: string | null): string | null {
  if (!publicUrl) return null;
  const marker = `/${bucket}/`;
  const idx = publicUrl.indexOf(marker);
  if (idx < 0) return null;
  return decodeURIComponent(publicUrl.slice(idx + marker.length).split("?")[0] ?? "");
}
