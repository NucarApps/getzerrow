// Thread context for thread-scope rules (rules upgrade, task 6). Loads a
// bounded, decrypted subset of the PRIOR messages in a thread so
// classifyByRules can evaluate run_on_threads folders across the whole
// conversation.
//
// Bounded on purpose: at most THREAD_CONTEXT_LIMIT prior messages, each
// body truncated to THREAD_BODY_TRUNCATE chars (matching the filter
// engine's regex input cap) — a giant thread can't balloon the classify
// hot path. Best-effort: any error returns an empty list (the folder
// simply behaves message-scoped for that email) and never blocks ingest.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { logError } from "@/lib/log.server";
import type { AccountContext } from "./account-context";
import { getEmailsDecrypted } from "./encrypted-reader";
import type { EmailForFilter } from "./filter-engine";

export const THREAD_CONTEXT_LIMIT = 10;
export const THREAD_BODY_TRUNCATE = 10_000;

/** Whether any folder in the account opted into thread-scope rules —
 * callers skip the thread fetch entirely when false. */
export function threadScopeEnabled(context: AccountContext): boolean {
  return context.folders.some((f) => f.run_on_threads === true);
}

/** Prior messages of `threadId` (newest first, excluding the message
 * being classified), decrypted and truncated for filter evaluation. */
export async function loadThreadEmailsForClassify(
  accountId: string,
  threadId: string | null | undefined,
  excludeGmailMessageId: string,
): Promise<EmailForFilter[]> {
  if (!threadId) return [];
  try {
    const { data: idRows, error } = await supabaseAdmin
      .from("emails")
      .select("id, gmail_message_id")
      .eq("gmail_account_id", accountId)
      .eq("thread_id", threadId)
      .order("received_at", { ascending: false })
      .limit(THREAD_CONTEXT_LIMIT + 1);
    if (error) throw new Error(error.message);
    const ids = (idRows ?? [])
      .filter((r) => r.gmail_message_id !== excludeGmailMessageId)
      .slice(0, THREAD_CONTEXT_LIMIT)
      .map((r) => r.id);
    if (ids.length === 0) return [];

    const { rows, error: decErr } = await getEmailsDecrypted(ids);
    if (decErr) throw new Error(decErr);
    return rows.map((r) => ({
      from_addr: r.from_addr ?? "",
      from_name: r.from_name ?? "",
      to_addrs: r.to_addrs ?? "",
      cc: r.cc ?? undefined,
      list_id: r.list_id ?? undefined,
      in_reply_to: r.in_reply_to ?? undefined,
      subject: r.subject ?? "",
      body_text: (r.body_text ?? "").slice(0, THREAD_BODY_TRUNCATE),
      has_attachment: r.has_attachment,
    }));
  } catch (e) {
    logError("thread_context.load_failed", { gmail_account_id: accountId, thread_id: threadId }, e);
    return [];
  }
}
