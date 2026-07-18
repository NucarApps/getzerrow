// Server-only helpers for storing / retrieving contact avatar photo bytes.
// Photos live in the `contact-photos` storage bucket under `{userId}/...`.
// We compute a short SHA-256 over the bytes so the filename bumps whenever
// the picture actually changes — this doubles as a cache-buster in the
// public URL saved to `contacts.avatar_url` and as the etag we compare
// against when deciding whether to push/pull.
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const CONTACT_PHOTO_BUCKET = "contact-photos";
const MAX_PHOTO_BYTES = 5 * 1024 * 1024; // 5 MB — iOS caps around 2 MB anyway
export type ContactPhotoSource = "unknown" | "user_upload" | "carddav" | "google" | "company_logo";

async function shortHash(bytes: Uint8Array): Promise<string> {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", buf);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex.slice(0, 16);
}

function extForMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes("png")) return "png";
  if (m.includes("gif")) return "gif";
  if (m.includes("webp")) return "webp";
  return "jpg";
}

function pathToBucketKey(publicUrl: string | null): string | null {
  if (!publicUrl) return null;
  const marker = `/${CONTACT_PHOTO_BUCKET}/`;
  const idx = publicUrl.indexOf(marker);
  if (idx < 0) return null;
  return decodeURIComponent(publicUrl.slice(idx + marker.length).split("?")[0]);
}

/**
 * Upload photo bytes for a contact and update `contacts.avatar_url`.
 * Old bucket objects are removed after the new URL is committed so we don't
 * accumulate orphans. Returns the new public URL plus the short SHA-256 that
 * can be persisted as an etag for delta sync.
 */
export async function saveContactPhoto(
  userId: string,
  contactId: string,
  bytes: Uint8Array,
  mime: string,
  source: ContactPhotoSource = "unknown",
): Promise<{ avatarUrl: string; hash: string }> {
  if (bytes.length === 0) throw new Error("Empty photo bytes");
  if (bytes.length > MAX_PHOTO_BYTES) throw new Error("Photo too large");

  const hash = await shortHash(bytes);
  const ext = extForMime(mime);
  const key = `${userId}/${contactId}-${hash}.${ext}`;

  // Fetch the currently-linked bucket key so we can prune it after upload.
  const { data: current } = await supabaseAdmin
    .from("contacts")
    .select("avatar_url")
    .eq("id", contactId)
    .eq("user_id", userId)
    .maybeSingle();
  const previousKey = pathToBucketKey(current?.avatar_url ?? null);

  const { error: upErr } = await supabaseAdmin.storage
    .from(CONTACT_PHOTO_BUCKET)
    .upload(key, bytes, { contentType: mime || "image/jpeg", upsert: true });
  if (upErr) throw new Error(upErr.message);

  const { data: pub } = supabaseAdmin.storage.from(CONTACT_PHOTO_BUCKET).getPublicUrl(key);
  const avatarUrl = pub.publicUrl;

  const { error: updErr } = await supabaseAdmin
    .from("contacts")
    .update({
      avatar_url: avatarUrl,
      avatar_source: source,
      company_logo_photo_sha: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", contactId)
    .eq("user_id", userId);
  if (updErr) throw new Error(updErr.message);

  if (previousKey && previousKey !== key) {
    await supabaseAdmin.storage.from(CONTACT_PHOTO_BUCKET).remove([previousKey]);
  }

  return { avatarUrl, hash };
}

/** Remove the current avatar for a contact (storage + DB). */
export async function deleteContactPhoto(userId: string, contactId: string): Promise<void> {
  const { data: current } = await supabaseAdmin
    .from("contacts")
    .select("avatar_url")
    .eq("id", contactId)
    .eq("user_id", userId)
    .maybeSingle();
  const key = pathToBucketKey(current?.avatar_url ?? null);
  if (key) {
    await supabaseAdmin.storage.from(CONTACT_PHOTO_BUCKET).remove([key]);
  }
  await supabaseAdmin
    .from("contacts")
    .update({ avatar_url: null, avatar_source: "unknown", updated_at: new Date().toISOString() })
    .eq("id", contactId)
    .eq("user_id", userId);
}

/**
 * Download the raw bytes of a contact's stored photo. Reads from storage
 * directly (rather than fetching the public URL) so this works without any
 * network egress and can serve CardDAV vCard responses.
 */
export async function loadContactPhotoBytes(
  avatarUrl: string | null,
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const key = pathToBucketKey(avatarUrl);
  if (!key) return null;
  const { data, error } = await supabaseAdmin.storage
    .from(CONTACT_PHOTO_BUCKET)
    .download(key);
  if (error || !data) return null;
  const buf = new Uint8Array(await data.arrayBuffer());
  const mime = data.type || "image/jpeg";
  return { bytes: buf, mime };
}

/** Compute the short SHA-256 the storage layer uses for a byte array. Handy
 * for callers that want to decide whether to re-upload before hitting storage. */
export async function contactPhotoHash(bytes: Uint8Array): Promise<string> {
  return shortHash(bytes);
}

/** Full SHA-256 hex of a byte array. Used to fingerprint the exact company
 * logo we inlined into a vCard PHOTO so a round-tripped copy from iOS can
 * be recognized and skipped instead of promoted to a real personal avatar. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}


/** Mint a short-lived signed URL for a contact's stored photo. Returns null
 * when the contact has no `avatar_url` on file, when the URL doesn't point
 * at our bucket, or when signing fails. Callers must verify ownership
 * before invoking this. */
export async function signContactPhotoUrl(
  userId: string,
  contactId: string,
): Promise<string | null> {
  const { data: current } = await supabaseAdmin
    .from("contacts")
    .select("avatar_url")
    .eq("id", contactId)
    .eq("user_id", userId)
    .maybeSingle();
  const key = pathToBucketKey(current?.avatar_url ?? null);
  if (!key) return null;
  const { data, error } = await supabaseAdmin.storage
    .from(CONTACT_PHOTO_BUCKET)
    .createSignedUrl(key, 60 * 60); // 1 hour
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}
