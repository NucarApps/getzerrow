// Nightly AI sender categorization (rules upgrade, task 7). For each user,
// picks recent contacts that aren't in any AI-derived group yet, asks the
// Lovable AI gateway (timeboxed) for one label per sender from a FIXED set,
// then upserts contact_groups rows with kind='ai_category' and adds the
// memberships. Deterministic rules keep working unchanged: sender_in_group
// already matches against every group a sender belongs to.
import { z } from "zod";
import { generateText } from "ai";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getModel } from "@/lib/ai-gateway";
import { raceTimeout } from "@/lib/ai-budget";
import { AI_CLASSIFY_ATTEMPT_TIMEOUT_MS } from "@/lib/sync/config";
import { logError, logInfo } from "@/lib/log.server";

/** Fixed label set — group display name per category. */
export const SENDER_CATEGORIES: Record<string, string> = {
  recruiter: "Recruiters",
  vendor: "Vendors",
  newsletter: "Newsletters",
  customer: "Customers",
  personal: "Personal",
  service: "Services",
};
const CATEGORY_KEYS = Object.keys(SENDER_CATEGORIES);
/** Per-user cap per nightly run — keeps the prompt compact and the AI
 * spend bounded. Uncategorized senders drain over successive nights. */
export const MAX_SENDERS_PER_USER = 25;
const MAX_USERS_PER_RUN = 50;
const GROUP_COLOR = "#8b5cf6";

const verdictSchema = z.record(z.string(), z.string());

/** One sender the AI labels: address + display name only (no bodies). */
export type SenderSample = { contact_id: string; email: string; name: string | null };

export type CategorizeAiFn = (senders: SenderSample[]) => Promise<Record<string, string>>;

function adminTable(name: string) {
  return (supabaseAdmin as unknown as SupabaseClient).from(name);
}

/** Default AI labeler: one compact batched prompt via the Lovable gateway.
 * Sender names are user-address-book data, not email bodies — still kept
 * short and JSON-fenced to bound the prompt. */
export async function labelSendersWithAi(senders: SenderSample[]): Promise<Record<string, string>> {
  const model = getModel();
  const list = senders
    .map((s) => `${s.email}${s.name ? ` (${s.name.slice(0, 60)})` : ""}`)
    .join("\n");
  const { text } = await raceTimeout(
    generateText({
      model,
      prompt:
        `Classify each email sender into exactly one category from this list: ` +
        `${CATEGORY_KEYS.join(", ")}.\n` +
        `Reply with ONLY a JSON object mapping each sender address to its category.\n` +
        `Senders:\n${list.slice(0, 6000)}`,
    }),
    AI_CLASSIFY_ATTEMPT_TIMEOUT_MS,
    "categorize-senders",
  );
  const jsonText = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return verdictSchema.parse(JSON.parse(jsonText));
}

/** Contacts (with email) not yet in any AI-derived group, newest first. */
async function pickUncategorized(userId: string): Promise<SenderSample[]> {
  const { data: aiGroups } = await adminTable("contact_groups")
    .select("id")
    .eq("user_id", userId)
    .eq("kind", "ai_category");
  const groupIds = (aiGroups ?? []).map((g: { id: string }) => g.id);
  let memberIds = new Set<string>();
  if (groupIds.length > 0) {
    const { data: members } = await adminTable("contact_group_members")
      .select("contact_id")
      .eq("user_id", userId)
      .in("group_id", groupIds);
    memberIds = new Set((members ?? []).map((m: { contact_id: string }) => m.contact_id));
  }
  const { data: contacts } = await adminTable("contacts")
    .select("id,email,name")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(MAX_SENDERS_PER_USER * 4);
  return ((contacts ?? []) as Array<{ id: string; email: string | null; name: string | null }>)
    .filter((c) => !!c.email && !memberIds.has(c.id))
    .slice(0, MAX_SENDERS_PER_USER)
    .map((c) => ({ contact_id: c.id, email: c.email!.toLowerCase(), name: c.name }));
}

/** Find-or-create the user's AI category group for a label; idempotent via
 * the (user_id, lower(name)) unique index. */
async function ensureGroup(userId: string, category: string): Promise<string | null> {
  const name = SENDER_CATEGORIES[category];
  if (!name) return null;
  const { data: existing } = await adminTable("contact_groups")
    .select("id,kind")
    .eq("user_id", userId)
    .ilike("name", name)
    .maybeSingle();
  if (existing?.id) return existing.kind === "ai_category" ? existing.id : null;
  // Client-generated id: one round trip, and the (user_id, lower(name))
  // unique index still dedupes concurrent runs.
  const id = crypto.randomUUID();
  const { error } = await adminTable("contact_groups").insert({
    id,
    user_id: userId,
    name,
    color: GROUP_COLOR,
    kind: "ai_category",
  });
  if (error) return null;
  return id;
}

/** One categorization pass for one user. Returns counts for the cron log. */
export async function categorizeSendersForUser(
  userId: string,
  ai: CategorizeAiFn = labelSendersWithAi,
): Promise<{ labeled: number; skipped: number }> {
  const senders = await pickUncategorized(userId);
  if (senders.length === 0) return { labeled: 0, skipped: 0 };
  const verdicts = await ai(senders);
  let labeled = 0;
  let skipped = 0;
  for (const s of senders) {
    const category = (verdicts[s.email] ?? "").toLowerCase().trim();
    if (!CATEGORY_KEYS.includes(category)) {
      skipped++;
      continue;
    }
    const groupId = await ensureGroup(userId, category);
    if (!groupId) {
      skipped++;
      continue;
    }
    const { error } = await adminTable("contact_group_members").upsert(
      { group_id: groupId, contact_id: s.contact_id, user_id: userId },
      { onConflict: "group_id,contact_id", ignoreDuplicates: true },
    );
    if (error) skipped++;
    else labeled++;
  }
  return { labeled, skipped };
}

/** Nightly entrypoint: every user with a connected Gmail account. */
export async function categorizeSenders(
  ai: CategorizeAiFn = labelSendersWithAi,
): Promise<{ users: number; labeled: number; skipped: number }> {
  const { data: accounts, error } = await supabaseAdmin.from("gmail_accounts").select("user_id");
  if (error) throw new Error(error.message);
  const userIds = [...new Set((accounts ?? []).map((a) => a.user_id as string))].slice(
    0,
    MAX_USERS_PER_RUN,
  );
  let labeled = 0;
  let skipped = 0;
  for (const userId of userIds) {
    try {
      const r = await categorizeSendersForUser(userId, ai);
      labeled += r.labeled;
      skipped += r.skipped;
    } catch (e) {
      // Per-user isolation: one user's AI failure must not starve the rest.
      logError("categorize_senders.user_failed", { user_id: userId }, e);
    }
  }
  logInfo("categorize_senders.done", { users: userIds.length, labeled, skipped });
  return { users: userIds.length, labeled, skipped };
}
