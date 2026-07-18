// Server fns for un-freezing company-logo snapshots that iOS accidentally
// promoted into a contact's real avatar (see plan: company-logo photo
// round-trip). Walk the caller's contacts, and for any whose stored
// `avatar_url` bytes match the currently-chosen company logo bytes, clear
// the avatar so the CardDAV/UI fallback flows through the live logo again.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const listContactsForLogoCleanup = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ ids: string[] }> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("contacts")
      .select("id")
      .eq("user_id", context.userId)
      .not("avatar_url", "is", null)
      .not("company_id", "is", null)
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    return { ids: (data ?? []).map((r) => (r as { id: string }).id) };
  });

export const cleanupCompanyLogoPhotosBatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ ids: z.array(z.string().uuid()).min(1).max(20) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const {
      loadContactPhotoBytes,
      deleteContactPhoto,
      sha256Hex,
    } = await import("@/lib/contacts/photos.server");
    const { fetchChosenCompanyLogoBytes, logoDomainForContact } = await import(
      "@/lib/contacts/logo-photo.server"
    );

    const { data: rows, error } = await supabaseAdmin
      .from("contacts")
      .select("id,avatar_url,email,website,company_id")
      .in("id", data.ids)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);

    let cleared = 0;
    const kept: string[] = [];
    for (const row of rows ?? []) {
      const r = row as {
        id: string;
        avatar_url: string | null;
        email: string | null;
        website: string | null;
        company_id: string | null;
      };
      if (!r.avatar_url || !r.company_id) {
        kept.push(r.id);
        continue;
      }
      const own = await loadContactPhotoBytes(r.avatar_url);
      if (!own) {
        kept.push(r.id);
        continue;
      }
      const logo = await fetchChosenCompanyLogoBytes(
        context.userId,
        logoDomainForContact(r),
      );
      if (!logo) {
        kept.push(r.id);
        continue;
      }
      const [ownSha, logoSha] = await Promise.all([
        sha256Hex(own.bytes),
        sha256Hex(logo.bytes),
      ]);
      if (ownSha === logoSha) {
        await deleteContactPhoto(context.userId, r.id);
        await supabaseAdmin
          .from("contacts")
          .update({ company_logo_photo_sha: logoSha })
          .eq("id", r.id)
          .eq("user_id", context.userId);
        cleared += 1;
      } else {
        kept.push(r.id);
      }
    }

    if (cleared > 0) {
      // Bump the CardDAV resync nonce so iPhone re-pulls fresh vCards.
      const { data: existing } = await supabaseAdmin
        .from("carddav_settings")
        .select("resync_nonce")
        .eq("user_id", context.userId)
        .maybeSingle();
      const next =
        ((existing as { resync_nonce?: number } | null)?.resync_nonce ?? 0) + 1;
      await supabaseAdmin
        .from("carddav_settings")
        .upsert(
          { user_id: context.userId, resync_nonce: next },
          { onConflict: "user_id" },
        );
    }

    return { cleared, kept: kept.length };
  });
