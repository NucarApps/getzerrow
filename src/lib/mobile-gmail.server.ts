// Server-only core for the mobile Gmail connect flow. Mirrors the web
// `connectGmailFromSession` server function so the Swift app can hand off the
// Google OAuth tokens it obtained on-device, kick off sync, and read back the
// user's categorization rules (folders + filters) in one round-trip.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { ensureWatch } from "./gmail.server";
import { backfillRecent, startBackfillJob } from "./sync.server";
import { exchangeCode, fetchUserEmail } from "./google-oauth.server";
import { logAudit, logError } from "./log.server";

type UpsertRpc = {
  rpc: (
    fn: "upsert_gmail_oauth_account",
    args: {
      p_user_id: string;
      p_email_address: string;
      p_access_token: string;
      p_refresh_token: string;
      p_token_expires_at: string;
      p_key: string;
    },
  ) => Promise<{ data: string | null; error: { message: string } | null }>;
};

export type MobileConnectInput = {
  // Direct token handoff (GoogleSignIn on-device with offline access).
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  email_address?: string;
  // Alternative: a server auth code the backend exchanges for tokens.
  server_auth_code?: string;
};

/**
 * Persist the user's Gmail OAuth tokens (encrypted via upsert_gmail_oauth_account),
 * start the Gmail push watch, and trigger backfill. Returns the account id.
 * Accepts either a refresh_token/access_token pair or a server_auth_code.
 */
export async function connectGmailCore(
  userId: string,
  input: MobileConnectInput,
): Promise<{ account_id: string; email_address: string }> {
  const encKey = process.env.EMAIL_ENC_KEY;
  if (!encKey) throw new Error("Server is not configured for Gmail connect");

  let accessToken = input.access_token;
  let refreshToken = input.refresh_token;
  let expiresIn = input.expires_in;
  let emailAddress = input.email_address;

  // Exchange a server auth code when the app didn't pass tokens directly.
  if (input.server_auth_code) {
    // Native flows use an empty redirect_uri for the code exchange.
    const tokens = await exchangeCode(input.server_auth_code, "");
    accessToken = tokens.access_token;
    refreshToken = tokens.refresh_token ?? refreshToken;
    expiresIn = tokens.expires_in;
    if (!emailAddress) emailAddress = await fetchUserEmail(tokens.access_token);
  }

  if (!accessToken || !refreshToken) {
    throw new Error(
      "Missing Google tokens — send a refresh_token/access_token pair or a server_auth_code",
    );
  }
  if (!emailAddress) {
    emailAddress = await fetchUserEmail(accessToken);
  }

  const ttl =
    typeof expiresIn === "number" && expiresIn > 0 ? Math.min(expiresIn, 60 * 60 * 24) : 3600;
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();

  const { data: accountId, error } = await (supabaseAdmin as unknown as UpsertRpc).rpc(
    "upsert_gmail_oauth_account",
    {
      p_user_id: userId,
      p_email_address: emailAddress.toLowerCase(),
      p_access_token: accessToken,
      p_refresh_token: refreshToken,
      p_token_expires_at: expiresAt,
      p_key: encKey,
    },
  );
  if (error || !accountId) throw new Error(`Failed to save account: ${error?.message}`);

  logAudit("gmail.connected", { user_id: userId, account_id: accountId, source: "mobile" });

  // Start the Gmail push watch (best-effort — sync fallbacks cover failures).
  try {
    const watch = await ensureWatch(accountId, null);
    if (watch) {
      await supabaseAdmin
        .from("gmail_accounts")
        .update({
          history_id: watch.historyId,
          watch_expiration: new Date(parseInt(watch.expiration, 10)).toISOString(),
        })
        .eq("id", accountId);
    }
  } catch (e) {
    logError(
      "gmail.mobile_connect.ensure_watch_failed",
      { account_id: accountId, user_id: userId },
      e,
    );
  }

  // Immediate light backfill so the inbox isn't empty, then a deeper background job.
  try {
    await backfillRecent(accountId, userId, 30);
  } catch (e) {
    logError("gmail.mobile_connect.backfill_failed", { account_id: accountId, user_id: userId }, e);
  }
  try {
    await startBackfillJob(accountId, userId, { months: 6 });
  } catch (e) {
    logError(
      "gmail.mobile_connect.start_backfill_failed",
      { account_id: accountId, user_id: userId },
      e,
    );
  }

  return { account_id: accountId, email_address: emailAddress.toLowerCase() };
}

export type CategorizationRule = {
  id: string;
  name: string;
  color: string | null;
  priority: number;
  gmail_label_id: string | null;
  ai_rule: string | null;
  filter_logic: string | null;
  filter_tree: unknown;
  auto_archive: boolean;
  auto_mark_read: boolean;
  auto_star: boolean;
  hide_from_inbox: boolean;
  skip_ai: boolean;
  min_ai_confidence: number | null;
  snooze_hours: number | null;
  forward_to: string | null;
  filters: { field: string; op: string; value: string }[];
};

/**
 * Read the user's folders and their deterministic filters so the mobile app
 * can display / mirror how mail is categorized. RLS-safe read via the
 * authenticated user's own rows.
 */
export async function getCategorizationRules(userId: string): Promise<CategorizationRule[]> {
  const { data: folders, error } = await supabaseAdmin
    .from("folders")
    .select(
      "id, name, color, priority, gmail_label_id, ai_rule, filter_logic, filter_tree, auto_archive, auto_mark_read, auto_star, hide_from_inbox, skip_ai, min_ai_confidence, snooze_hours, forward_to",
    )
    .eq("user_id", userId)
    .order("priority", { ascending: true });
  if (error) throw new Error(`Failed to load folders: ${error.message}`);

  const folderIds = (folders ?? []).map((f) => f.id);
  const filtersByFolder = new Map<string, { field: string; op: string; value: string }[]>();
  if (folderIds.length > 0) {
    const { data: filters } = await supabaseAdmin
      .from("folder_filters")
      .select("folder_id, field, op, value")
      .in("folder_id", folderIds);
    for (const f of filters ?? []) {
      const list = filtersByFolder.get(f.folder_id) ?? [];
      list.push({ field: f.field, op: f.op, value: f.value });
      filtersByFolder.set(f.folder_id, list);
    }
  }

  return (folders ?? []).map((f) => ({
    id: f.id,
    name: f.name,
    color: f.color,
    priority: f.priority,
    gmail_label_id: f.gmail_label_id,
    ai_rule: f.ai_rule,
    filter_logic: f.filter_logic,
    filter_tree: f.filter_tree,
    auto_archive: f.auto_archive,
    auto_mark_read: f.auto_mark_read,
    auto_star: f.auto_star,
    hide_from_inbox: f.hide_from_inbox,
    skip_ai: f.skip_ai,
    min_ai_confidence: f.min_ai_confidence,
    snooze_hours: f.snooze_hours,
    forward_to: f.forward_to,
    filters: filtersByFolder.get(f.id) ?? [],
  }));
}
