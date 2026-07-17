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
    const { ensureSyncState, updateSyncState } = await import(
      "@/lib/google-contacts/state.server"
    );
    const state = await ensureSyncState(context.userId, data.accountId);
    if (!state.enabled) await updateSyncState(state.id, { enabled: true });
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
    await updateSyncState(state.id, { enabled: data.enabled });
    return { ok: true };
  });
