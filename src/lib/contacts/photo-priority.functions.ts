// Server fns to set the photo priority at three tiers (global default, per
// company, per contact). Every write also nudges Google + iOS sync so the
// new choice propagates without waiting for the next scheduled tick.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const PRIORITY = z.enum(["company_first", "personal_first", "personal_only"]);

export const setGlobalPhotoPriority = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ priority: PRIORITY }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { bumpResyncNonce } = await import("@/lib/carddav/settings.functions");
    const { error } = await supabase
      .from("carddav_settings")
      .upsert(
        { user_id: userId, photo_priority: data.priority },
        { onConflict: "user_id" },
      );
    if (error) throw new Error(error.message);
    await bumpResyncNonce(supabase, userId);
    await markAllContactsPhotoDirty(userId);
    return { ok: true };
  });

export const setCompanyPhotoPriority = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({ companyId: z.string().uuid(), priority: PRIORITY.nullable() })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("companies")
      .update({ photo_priority: data.priority })
      .eq("id", data.companyId)
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: rows } = await supabaseAdmin
      .from("contacts")
      .select("id")
      .eq("user_id", userId)
      .eq("company_id", data.companyId);
    const ids = (rows ?? []).map((r) => (r as { id: string }).id);
    await markContactsPhotoDirty(userId, ids);
    await bumpNonce(userId);
    return { ok: true, contactsAffected: ids.length };
  });

export const setContactPhotoPriority = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({ contactId: z.string().uuid(), priority: PRIORITY.nullable() })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("contacts")
      .update({ photo_priority: data.priority, updated_at: new Date().toISOString() })
      .eq("id", data.contactId)
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
    await markContactsPhotoDirty(userId, [data.contactId]);
    await bumpNonce(userId);
    return { ok: true };
  });

async function markContactsPhotoDirty(userId: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const { markGooglePhotoDirtyMany } = await import("@/lib/google-contacts/mark-dirty.server");
  await markGooglePhotoDirtyMany(userId, ids);
}

async function markAllContactsPhotoDirty(userId: string): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  await supabaseAdmin
    .from("google_contact_links")
    .update({ photo_etag: null, photo_push_attempts: 0 })
    .eq("user_id", userId);
}

async function bumpNonce(userId: string): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("carddav_settings")
    .select("resync_nonce")
    .eq("user_id", userId)
    .maybeSingle();
  const next = ((data as { resync_nonce?: number } | null)?.resync_nonce ?? 0) + 1;
  await supabaseAdmin
    .from("carddav_settings")
    .upsert({ user_id: userId, resync_nonce: next }, { onConflict: "user_id" });
}

export const getPhotoPrioritySettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data } = await supabase
      .from("carddav_settings")
      .select("photo_priority")
      .eq("user_id", userId)
      .maybeSingle();
    const global =
      (data as { photo_priority?: "company_first" | "personal_first" | "personal_only" } | null)
        ?.photo_priority ?? "company_first";
    return { global };
  });
