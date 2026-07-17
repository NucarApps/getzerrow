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
  .inputValidator((d: { accountId: string }) =>
    z.object({ accountId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertOwnsAccount(context.userId, data.accountId);
    const { runGoogleContactsSync } = await import(
      "@/lib/google-contacts/reconcile.server"
    );
    // Ensure sync is enabled (a manual run is an implicit opt-in).
    // Default new opt-ins to pull-only so the first run is safe (read-only
    // from Google's side) — the user can upgrade to two-way from settings.
    const { ensureSyncState, updateSyncState } = await import(
      "@/lib/google-contacts/state.server"
    );
    const state = await ensureSyncState(context.userId, data.accountId);
    if (!state.enabled) {
      await updateSyncState(state.id, {
        enabled: true,
        sync_mode: state.sync_mode === "off" ? "pull_only" : state.sync_mode,
      });
    }
    return await runGoogleContactsSync(context.userId, data.accountId);
  });

export const getGoogleContactsSyncStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { accountId: string }) =>
    z.object({ accountId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertOwnsAccount(context.userId, data.accountId);
    const { getGoogleContactsStatus } = await import(
      "@/lib/google-contacts/reconcile.server"
    );
    return await getGoogleContactsStatus(context.userId, data.accountId);
  });

const SYNC_MODES = ["off", "pull_only", "two_way"] as const;
type SyncMode = (typeof SYNC_MODES)[number];

export const setGoogleContactsSyncMode = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { accountId: string; mode: SyncMode }) =>
    z
      .object({ accountId: z.string().uuid(), mode: z.enum(SYNC_MODES) })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertOwnsAccount(context.userId, data.accountId);
    const { ensureSyncState, updateSyncState } = await import(
      "@/lib/google-contacts/state.server"
    );
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
    const { ensureSyncState, updateSyncState } = await import(
      "@/lib/google-contacts/state.server"
    );
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
    const { ensureSyncState, updateSyncState } = await import(
      "@/lib/google-contacts/state.server"
    );
    const state = await ensureSyncState(context.userId, data.accountId);
    await updateSyncState(state.id, {
      enabled: data.enabled,
      sync_mode: data.enabled
        ? state.sync_mode === "off"
          ? "pull_only"
          : state.sync_mode
        : "off",
    });
    return { ok: true };
  });
