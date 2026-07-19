// Server-only helpers for a company's uploaded custom logo. Lives in the
// PUBLIC `company-logos` bucket under `{userId}/{companyId}-{hash}.{ext}` so
// one URL serves both the web <img> and the server-side CardDAV download.
// A custom company photo takes priority over the picked/auto brand logo and
// cascades to every member of the company that has no photo of their own.
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const COMPANY_LOGO_BUCKET = "company-logos";
const MAX_LOGO_BYTES = 5 * 1024 * 1024;

async function shortHash(bytes: Uint8Array): Promise<string> {
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

function extForMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes("png")) return "png";
  if (m.includes("gif")) return "gif";
  if (m.includes("webp")) return "webp";
  return "jpg";
}

function pathToBucketKey(publicUrl: string | null): string | null {
  if (!publicUrl) return null;
  const marker = `/${COMPANY_LOGO_BUCKET}/`;
  const idx = publicUrl.indexOf(marker);
  if (idx < 0) return null;
  return decodeURIComponent(publicUrl.slice(idx + marker.length).split("?")[0]);
}

/** Upload a custom logo for a company and set `companies.logo_url`. Records
 *  the bytes' SHA-256 into `company_logo_hashes` so an iOS round-trip of this
 *  photo (served to a member) is recognized as an echo, not promoted to a
 *  member's personal avatar. Prunes the previous object. */
export async function saveCompanyPhoto(
  userId: string,
  companyId: string,
  bytes: Uint8Array,
  mime: string,
): Promise<{ logoUrl: string; sha: string }> {
  if (bytes.length === 0) throw new Error("Empty photo bytes");
  if (bytes.length > MAX_LOGO_BYTES) throw new Error("Photo too large");

  const hash = await shortHash(bytes);
  const ext = extForMime(mime);
  const key = `${userId}/${companyId}-${hash}.${ext}`;

  const { data: current } = await supabaseAdmin
    .from("companies")
    .select("logo_url")
    .eq("id", companyId)
    .eq("user_id", userId)
    .maybeSingle();
  const previousKey = pathToBucketKey(
    (current as { logo_url?: string | null } | null)?.logo_url ?? null,
  );

  const { error: upErr } = await supabaseAdmin.storage
    .from(COMPANY_LOGO_BUCKET)
    .upload(key, bytes, { contentType: mime || "image/jpeg", upsert: true });
  if (upErr) throw new Error(upErr.message);

  const { data: pub } = supabaseAdmin.storage.from(COMPANY_LOGO_BUCKET).getPublicUrl(key);
  const logoUrl = pub.publicUrl;

  const { error: updErr } = await supabaseAdmin
    .from("companies")
    .update({ logo_url: logoUrl, updated_at: new Date().toISOString() })
    .eq("id", companyId)
    .eq("user_id", userId);
  if (updErr) throw new Error(updErr.message);

  // Fingerprint this photo as a known company logo so the CardDAV echo guard
  // and getContact self-heal recognize it if it round-trips from a member.
  const { sha256Hex } = await import("@/lib/contacts/photos.server");
  const { recordCompanyLogoHash } = await import("@/lib/contacts/logo-photo.server");
  const sha = await sha256Hex(bytes);
  await recordCompanyLogoHash({
    userId,
    companyId,
    domain: null,
    sha256: sha,
    source: "custom_upload",
  });

  if (previousKey && previousKey !== key) {
    await supabaseAdmin.storage.from(COMPANY_LOGO_BUCKET).remove([previousKey]);
  }

  return { logoUrl, sha };
}

/** Remove a company's custom logo (storage + DB). Members fall back to the
 *  picked/auto brand logo again. */
export async function deleteCompanyPhoto(userId: string, companyId: string): Promise<void> {
  const { data: current } = await supabaseAdmin
    .from("companies")
    .select("logo_url")
    .eq("id", companyId)
    .eq("user_id", userId)
    .maybeSingle();
  const key = pathToBucketKey((current as { logo_url?: string | null } | null)?.logo_url ?? null);
  if (key) {
    await supabaseAdmin.storage.from(COMPANY_LOGO_BUCKET).remove([key]);
  }
  const { error } = await supabaseAdmin
    .from("companies")
    .update({ logo_url: null, updated_at: new Date().toISOString() })
    .eq("id", companyId)
    .eq("user_id", userId);
  if (error) throw new Error(error.message);
}

/** Download the raw bytes of a company's custom logo for CardDAV serving.
 *  Reads storage directly (no network egress). */
export async function loadCompanyPhotoBytes(
  logoUrl: string | null,
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const key = pathToBucketKey(logoUrl);
  if (!key) return null;
  const { data, error } = await supabaseAdmin.storage.from(COMPANY_LOGO_BUCKET).download(key);
  if (error || !data) return null;
  const buf = new Uint8Array(await data.arrayBuffer());
  return { bytes: buf, mime: data.type || "image/jpeg" };
}
