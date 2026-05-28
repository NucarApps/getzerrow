// Per-account context — the folders / filters / overrides / examples
// snapshot that the classifier needs to route a message. Built once at
// the top of a worker batch and reused for every message in that batch,
// so we don't re-fetch the same routing rules N times.
//
// CACHE
//   accountContextCache stores the built context per accountId for 5
//   seconds. Short TTL means a folder/filter mutation is visible to
//   newly-arriving mail within seconds; explicit invalidation hooks
//   below let callers force-bust the cache for instant pickup.
//
// MULTI-PROCESS
//   The cache is in-process. Cross-process workers each have their own
//   cache and refresh independently. That's acceptable because folder/
//   filter mutations are rare and the 5s TTL bounds the worst-case
//   staleness anyway.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { ClassifyFolder } from "../ai.server";
import type { Filter, Folder, OverrideException } from "./types";

export type AccountContext = {
  folders: Folder[];
  filters: Filter[];
  overrides: Array<{ id: string; match_type: string; value: string }>;
  overrideExceptions: OverrideException[];
  enrichedFolders: ClassifyFolder[];
};

const accountContextCache = new Map<string, { ctx: AccountContext; expires: number }>();
const ACCOUNT_CONTEXT_TTL_MS = 5_000;

/** Drop the cached context for one account. Call after writes to
 * folders / folder_filters for that account so the next mail to
 * arrive sees the change. */
export function invalidateAccountContext(accountId: string): void {
  accountContextCache.delete(accountId);
}

/** Drop the cached context for every account belonging to a user. Use
 * after writes to user-scoped tables (inbox_overrides,
 * inbox_override_exceptions) where you don't know which account caches
 * need to be busted. */
export async function invalidateAccountContextForUser(userId: string): Promise<void> {
  const { data } = await supabaseAdmin
    .from("gmail_accounts")
    .select("id")
    .eq("user_id", userId);
  for (const acc of data ?? []) accountContextCache.delete(acc.id);
}

/** Fetch up to 200 of the most recent folder_examples and group them
 * per-folder (capped at 5 per folder, which is what the AI classifier
 * consumes). Returns the ClassifyFolder shape ai.server expects. */
async function loadFoldersWithExamples(folders: Folder[]): Promise<ClassifyFolder[]> {
  if (folders.length === 0) return [];
  const { data: examples } = await supabaseAdmin
    .from("folder_examples")
    .select("folder_id, from_addr")
    .in("folder_id", folders.map((f) => f.id))
    .order("created_at", { ascending: false })
    .limit(200);
  const byFolder = new Map<string, Array<{ from_addr: string | null; subject: string | null }>>();
  for (const e of examples ?? []) {
    if (!byFolder.has(e.folder_id)) byFolder.set(e.folder_id, []);
    const arr = byFolder.get(e.folder_id)!;
    if (arr.length < 5) arr.push({ from_addr: e.from_addr, subject: null });
  }
  return folders.map((f) => ({
    id: f.id,
    name: f.name,
    ai_rule: f.ai_rule,
    learned_profile: f.learned_profile,
    examples: byFolder.get(f.id) ?? [],
  }));
}

export async function loadAccountContext(accountId: string, userId: string): Promise<AccountContext> {
  const cached = accountContextCache.get(accountId);
  if (cached && cached.expires > Date.now()) return cached.ctx;

  const [{ data: folders }, { data: overrides }, { data: exceptions }] = await Promise.all([
    supabaseAdmin
      .from("folders")
      .select("*")
      .eq("gmail_account_id", accountId)
      .order("priority", { ascending: false }),
    // Overrides scoped to this account (or unscoped legacy rows where
    // gmail_account_id IS NULL — those apply to every account).
    supabaseAdmin
      .from("inbox_overrides")
      .select("id, match_type, value")
      .eq("user_id", userId)
      .or(`gmail_account_id.eq.${accountId},gmail_account_id.is.null`),
    supabaseAdmin.from("inbox_override_exceptions").select("override_id, field, op, value").eq("user_id", userId),
  ]);

  const folderList = (folders ?? []) as Folder[];
  const folderIds = folderList.map((f) => f.id);
  // Scope filter fetch to this account's folders only — avoids pulling
  // every user's filters (RLS doesn't apply with the admin client) and
  // scales better as the table grows.
  let filterList: Filter[] = [];
  if (folderIds.length > 0) {
    const { data: filters } = await supabaseAdmin
      .from("folder_filters")
      .select("id, folder_id, field, op, value")
      .in("folder_id", folderIds);
    filterList = (filters ?? []) as Filter[];
  }
  const enrichedFolders = await loadFoldersWithExamples(folderList);

  const ctx: AccountContext = {
    folders: folderList,
    filters: filterList,
    overrides: overrides ?? [],
    overrideExceptions: (exceptions ?? []) as OverrideException[],
    enrichedFolders,
  };
  accountContextCache.set(accountId, { ctx, expires: Date.now() + ACCOUNT_CONTEXT_TTL_MS });
  return ctx;
}
