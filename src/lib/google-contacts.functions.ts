// Client-safe server fns for Google Contacts two-way sync.
// The heavy sync modules live under src/lib/google-contacts/ and are
// server-only — they are loaded via dynamic import inside handlers.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { z } from "zod";

async function assertOwnsAccount(userId: string, accountId: string): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("gmail_accounts")
    .select("id")
    .eq("id", accountId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`Account lookup failed: ${error.message}`);
  if (!data) throw new Error("Account not found");
}

export const syncGoogleContactsNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { accountId: string }) => z.object({ accountId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertOwnsAccount(context.userId, data.accountId);
    const { runGoogleContactsSync } = await import("@/lib/google-contacts/reconcile.server");
    // Ensure sync is enabled (a manual run is an implicit opt-in).
    // Default new opt-ins to pull-only so the first run is safe (read-only
    // from Google's side) — the user can upgrade to two-way from settings.
    const { ensureSyncState, updateSyncState } = await import("@/lib/google-contacts/state.server");
    const state = await ensureSyncState(context.userId, data.accountId);
    if (!state.enabled) {
      await updateSyncState(state.id, {
        enabled: true,
        sync_mode: state.sync_mode === "off" ? "pull_only" : state.sync_mode,
      });
    }
    return await runGoogleContactsSync(context.userId, data.accountId);
  });

export const forceFullGoogleContactsResync = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { accountId: string }) => z.object({ accountId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertOwnsAccount(context.userId, data.accountId);
    const { forceFullResync } = await import("@/lib/google-contacts/pull.server");
    const { ensureSyncState, updateSyncState } = await import("@/lib/google-contacts/state.server");
    const state = await ensureSyncState(context.userId, data.accountId);
    if (!state.enabled) {
      await updateSyncState(state.id, {
        enabled: true,
        sync_mode: state.sync_mode === "off" ? "pull_only" : state.sync_mode,
      });
    }
    await forceFullResync(context.userId, data.accountId);
    const { runGoogleContactsSync } = await import("@/lib/google-contacts/reconcile.server");
    return await runGoogleContactsSync(context.userId, data.accountId);
  });

export const getGoogleContactsSyncStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { accountId: string }) => z.object({ accountId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertOwnsAccount(context.userId, data.accountId);
    const { getGoogleContactsStatus } = await import("@/lib/google-contacts/reconcile.server");
    return await getGoogleContactsStatus(context.userId, data.accountId);
  });

const SYNC_MODES = ["off", "pull_only", "two_way"] as const;
type SyncMode = (typeof SYNC_MODES)[number];

export const setGoogleContactsSyncMode = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { accountId: string; mode: SyncMode }) =>
    z.object({ accountId: z.string().uuid(), mode: z.enum(SYNC_MODES) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertOwnsAccount(context.userId, data.accountId);
    const { ensureSyncState, updateSyncState } = await import("@/lib/google-contacts/state.server");
    const state = await ensureSyncState(context.userId, data.accountId);
    await updateSyncState(state.id, {
      sync_mode: data.mode,
      enabled: data.mode !== "off",
    });
    return { ok: true };
  });

const SYNC_INTERVALS = [5, 15, 60] as const;
type SyncInterval = (typeof SYNC_INTERVALS)[number];

export const setGoogleContactsSyncInterval = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { accountId: string; intervalMinutes: SyncInterval }) =>
    z
      .object({
        accountId: z.string().uuid(),
        intervalMinutes: z.union([z.literal(5), z.literal(15), z.literal(60)]),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertOwnsAccount(context.userId, data.accountId);
    const { ensureSyncState, updateSyncState } = await import("@/lib/google-contacts/state.server");
    const state = await ensureSyncState(context.userId, data.accountId);
    await updateSyncState(state.id, { sync_interval_minutes: data.intervalMinutes });
    return { ok: true };
  });

/** @deprecated Prefer setGoogleContactsSyncMode. Retained for older callers. */
export const setGoogleContactsSyncEnabled = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { accountId: string; enabled: boolean }) =>
    z.object({ accountId: z.string().uuid(), enabled: z.boolean() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertOwnsAccount(context.userId, data.accountId);
    const { ensureSyncState, updateSyncState } = await import("@/lib/google-contacts/state.server");
    const state = await ensureSyncState(context.userId, data.accountId);
    await updateSyncState(state.id, {
      enabled: data.enabled,
      sync_mode: data.enabled ? (state.sync_mode === "off" ? "pull_only" : state.sync_mode) : "off",
    });
    return { ok: true };
  });

async function assertOwnsContact(userId: string, contactId: string): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("contacts")
    .select("id")
    .eq("id", contactId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`Contact lookup failed: ${error.message}`);
  if (!data) throw new Error("Contact not found");
}

/** Additively re-pull one contact from Google to recover any missing emails/phones. */
export const repullContactFromGoogle = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { contactId: string }) => z.object({ contactId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertOwnsContact(context.userId, data.contactId);
    const { repullContact } = await import("@/lib/google-contacts/repair.server");
    return await repullContact(context.userId, data.contactId);
  });

/** Scan every linked contact for this account and additively import missing emails/phones. */
export const backfillMultiEmailsFromGoogle = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { accountId: string }) => z.object({ accountId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertOwnsAccount(context.userId, data.accountId);
    const { backfillMultiEmails } = await import("@/lib/google-contacts/repair.server");
    return await backfillMultiEmails(context.userId, data.accountId);
  });

/** Clear stored photo etags so the next Google pull re-downloads the photo
 * for every linked contact that currently has no local avatar. Fixes cases
 * where a picture was set on Google/iOS before Zerrow's photo sync shipped:
 * the pull loop otherwise short-circuits on the stable photo URL and never
 * touches those contacts again. */
export const backfillGoogleContactPhotos = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { accountId: string }) => z.object({ accountId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertOwnsAccount(context.userId, data.accountId);
    // Only pick links that are actually stale: local avatar missing AND we
    // still have a cached photo_etag. Rerunning after a successful backfill
    // (or on contacts that already have a photo) is a no-op — we skip the
    // UPDATE, skip the sync kick, and return `cleared: 0`.
    const { data: links, error } = await supabaseAdmin
      .from("google_contact_links")
      .select("contact_id, contacts!inner(avatar_url)")
      .eq("user_id", context.userId)
      .eq("gmail_account_id", data.accountId)
      .not("photo_etag", "is", null)
      .is("contacts.avatar_url", null);
    if (error) throw new Error(error.message);
    const ids = (links ?? [])
      .map((l) => (l as { contact_id?: string }).contact_id)
      .filter((v): v is string => !!v);
    if (ids.length === 0) {
      return { ok: true, cleared: 0, synced: false };
    }
    await supabaseAdmin
      .from("google_contact_links")
      .update({ photo_etag: null })
      .eq("gmail_account_id", data.accountId)
      .in("contact_id", ids);
    // Kick off a sync so the pull loop refetches photos on the next tick.
    const { runGoogleContactsSync } = await import("@/lib/google-contacts/reconcile.server");
    await runGoogleContactsSync(context.userId, data.accountId).catch(() => null);
    return { ok: true, cleared: ids.length, synced: true };
  });
