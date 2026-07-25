/**
 * Shared validation limits and decoding for base64 image uploads.
 *
 * Contact photos and company logos post raw bytes as base64 through a server
 * function (same-origin, so no FormData or signed-upload dance) and applied
 * the same ceiling and MIME allowlist from two copies of these constants.
 */

/** Ceiling on a single decoded upload. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** Image types accepted for contact photos and company logos. */
export const ALLOWED_MIME = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;

/** Decode a base64 payload to bytes. */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
