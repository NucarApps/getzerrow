// Applying a previewed change-set (Phase D).
//
// Moves go through the same destructive core as a manual move, so Gmail
// labels, raw_labels and the encrypted reason column all stay consistent
// with every other filing path.
//
// Server-side invariants (not just UI guards):
//   * hand-placed mail is refused — placed_by_user wins over any rule
//   * the row must belong to the caller
//   * a move to null goes back to the Inbox, not to a folder named Inbox
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { restoreEmailToInbox } from "../gmail-helpers.server";
import { performMove } from "../move-email.server";

export type AppliedMove = {
  email_id: string;
  ok: boolean;
  skipped?: "placed_by_user" | "not_found" | "unchanged";
  error?: string;
};

export type ApplyResult = {
  applied: number;
  skipped: number;
  failed: number;
  results: AppliedMove[];
};

export async function applyMoves(
  userId: string,
  moves: Array<{ email_id: string; to_folder_id: string | null }>,
): Promise<ApplyResult> {
  const results: AppliedMove[] = [];

  for (const move of moves) {
    const { data: email } = await supabaseAdmin
      .from("emails")
      .select(
        "id, user_id, folder_id, gmail_message_id, gmail_account_id, raw_labels, placed_by_user",
      )
      .eq("id", move.email_id)
      .maybeSingle();

    if (!email || email.user_id !== userId) {
      results.push({ email_id: move.email_id, ok: false, skipped: "not_found" });
      continue;
    }
    if (email.placed_by_user === true) {
      results.push({ email_id: move.email_id, ok: false, skipped: "placed_by_user" });
      continue;
    }
    if ((email.folder_id ?? null) === move.to_folder_id) {
      results.push({ email_id: move.email_id, ok: false, skipped: "unchanged" });
      continue;
    }

    if (move.to_folder_id) {
      const res = await performMove(
        userId,
        move.email_id,
        move.to_folder_id,
        "Applied from a rule change preview",
      );
      results.push(
        res.ok
          ? { email_id: move.email_id, ok: true }
          : { email_id: move.email_id, ok: false, error: res.error },
      );
      continue;
    }

    // Back to the Inbox: recompute raw_labels and sync Gmail the same way
    // the manual "move to inbox" action does.
    let fromLabel: string | null = null;
    if (email.folder_id) {
      const { data: f } = await supabaseAdmin
        .from("folders")
        .select("gmail_label_id")
        .eq("id", email.folder_id)
        .maybeSingle();
      fromLabel = f?.gmail_label_id ?? null;
    }
    try {
      await restoreEmailToInbox({
        emailId: email.id,
        gmailAccountId: email.gmail_account_id,
        gmailMessageId: email.gmail_message_id,
        currentLabels: (email.raw_labels ?? []) as string[],
        fromLabel,
        classifiedBy: "rule_replay",
        classificationReason: "Returned to the Inbox by a rule change preview",
        aiConfidence: 1,
        labelFailureLog: { event: "rules.replay.inbox_label_sync_failed" },
      });
      results.push({ email_id: move.email_id, ok: true });
    } catch (e) {
      results.push({
        email_id: move.email_id,
        ok: false,
        error: e instanceof Error ? e.message : "Failed to move to Inbox",
      });
    }
  }

  return {
    applied: results.filter((r) => r.ok).length,
    skipped: results.filter((r) => !r.ok && r.skipped).length,
    failed: results.filter((r) => !r.ok && !r.skipped).length,
    results,
  };
}
