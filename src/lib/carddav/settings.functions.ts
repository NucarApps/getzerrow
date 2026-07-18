import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const STYLES = ["leaf", "path_slash", "path_dash"] as const;
export type GroupNameStyle = (typeof STYLES)[number];

export type CardDavSettings = {
  group_name_style: GroupNameStyle;
  include_summary_in_notes: boolean;
  use_company_logo_fallback: boolean;
};

/** Read the caller's CardDAV display preferences. Returns defaults if no
 * row exists yet (a row is only written on first update). */
export const getCardDavSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<CardDavSettings> => {
    const { supabase, userId } = context;
    const { data, error } = await supabase
      .from("carddav_settings")
      .select("group_name_style, include_summary_in_notes, use_company_logo_fallback")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const row = data as
      | {
          group_name_style?: string;
          include_summary_in_notes?: boolean;
          use_company_logo_fallback?: boolean;
        }
      | null;
    const style: GroupNameStyle =
      row?.group_name_style === "leaf" || row?.group_name_style === "path_dash"
        ? row.group_name_style
        : "path_slash";
    return {
      group_name_style: style,
      include_summary_in_notes: row?.include_summary_in_notes ?? true,
      use_company_logo_fallback: row?.use_company_logo_fallback ?? true,
    };
  });

export const updateCardDavSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: {
    group_name_style?: GroupNameStyle;
    include_summary_in_notes?: boolean;
  }) =>
    z
      .object({
        group_name_style: z.enum(STYLES).optional(),
        include_summary_in_notes: z.boolean().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    // Bump resync_nonce whenever a setting that affects vCard output changes,
    // so iOS pulls a fresh copy of every contact on next sync.
    const { data: existing } = await supabase
      .from("carddav_settings")
      .select("resync_nonce, include_summary_in_notes")
      .eq("user_id", userId)
      .maybeSingle();
    const prev = existing as
      | { resync_nonce?: number; include_summary_in_notes?: boolean }
      | null;
    const nextNonce = (prev?.resync_nonce ?? 0) + 1;
    const patch: {
      user_id: string;
      resync_nonce: number;
      group_name_style?: GroupNameStyle;
      include_summary_in_notes?: boolean;
    } = {
      user_id: userId,
      resync_nonce: nextNonce,
    };
    if (data.group_name_style !== undefined) patch.group_name_style = data.group_name_style;
    if (data.include_summary_in_notes !== undefined)
      patch.include_summary_in_notes = data.include_summary_in_notes;
    const { error } = await supabase
      .from("carddav_settings")
      .upsert(patch, { onConflict: "user_id" });

    if (error) throw new Error(error.message);

    // If the summary-in-notes toggle actually changed, bump updated_at on every
    // contact that has a stored AI summary. That forces both the per-contact
    // CardDAV ETag and the Google push (which gates on updated_at >
    // last_synced_at) to re-emit the merged NOTE. Without this, contacts whose
    // summary predates this feature never re-sync because nothing has moved
    // their updated_at since the summary was first written.
    if (
      data.include_summary_in_notes !== undefined &&
      data.include_summary_in_notes !== (prev?.include_summary_in_notes ?? true)
    ) {
      await supabase
        .from("contacts")
        .update({ updated_at: new Date().toISOString() })
        .eq("user_id", userId)
        .not("relationship_summary", "is", null);
    }

    return { ok: true };
  });

/** Bump `contacts.updated_at` on every contact with a stored AI relationship
 * summary, so the CardDAV per-contact ETag changes and the Google push loop
 * picks them up on the next tick. Use this to backfill summaries that were
 * generated before the "include summary in notes" feature shipped. */
export const resyncSummaryContacts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data: existing } = await supabase
      .from("carddav_settings")
      .select("resync_nonce")
      .eq("user_id", userId)
      .maybeSingle();
    const nextNonce =
      ((existing as { resync_nonce?: number } | null)?.resync_nonce ?? 0) + 1;
    await supabase
      .from("carddav_settings")
      .upsert(
        { user_id: userId, resync_nonce: nextNonce },
        { onConflict: "user_id" },
      );

    const { data: touched, error } = await supabase
      .from("contacts")
      .update({ updated_at: new Date().toISOString() })
      .eq("user_id", userId)
      .not("relationship_summary", "is", null)
      .select("id");
    if (error) throw new Error(error.message);
    return { ok: true, count: touched?.length ?? 0 };
  });

/** Bump the resync nonce so the address-book CTag changes. iOS will pull a
 * fresh copy on its next sync tick (or immediately if the user opens
 * Contacts / pulls to refresh). Does not push to the phone. */
export const forceCarddavResync = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data: existing } = await supabase
      .from("carddav_settings")
      .select("resync_nonce")
      .eq("user_id", userId)
      .maybeSingle();
    const current =
      (existing as { resync_nonce?: number } | null)?.resync_nonce ?? 0;
    const next = current + 1;
    const { error } = await supabase
      .from("carddav_settings")
      .upsert(
        { user_id: userId, resync_nonce: next },
        { onConflict: "user_id" },
      );
    if (error) throw new Error(error.message);
    return { ok: true, resync_nonce: next };
  });
