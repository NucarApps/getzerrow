// Safety-net reconciliation. Walks recent + cursor-paged older local
// emails for an account and repairs anything that drifted from Gmail's
// canonical state. Catches messages whose history events we missed
// (Gmail history TTL is ~1 week — if the webhook + poll were both down
// across that window we'd otherwise lose the events).
//
// TWO-PASS DESIGN
//   1. Walks unarchived rows in two windows:
//      - Head: most recent 60 (capped at the user's limit) — what the
//        user is most likely to be looking at right now.
//      - Tail: older rows anchored at gmail_accounts.reconcile_cursor.
//        Across runs the cursor walks backwards, so a 1k-inbox is fully
//        covered in ~10 ticks instead of "the first 100 forever".
//      For each row: if it looks broken (missing body/from/subject),
//      re-fetch + patch. Otherwise just check labels.
//   2. Walks the 200 most-recent archived rows to detect "moved back
//      to inbox in Gmail" or "marked unread" changes the history poll
//      missed.
//
// The Gmail roundtrips are cheap (label-only fetches) for the common
// case where nothing has drifted.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getMessage, getMessageLabels, parseMessage } from "../gmail.server";
import { logError } from "../log.server";

export async function reconcileLocalInbox(accountId: string, limit = 100) {
  const { data: acc } = await supabaseAdmin
    .from("gmail_accounts")
    .select("reconcile_cursor")
    .eq("id", accountId)
    .maybeSingle();
  const cursor = acc?.reconcile_cursor ?? null;

  const HEAD_LIMIT = Math.min(limit, 60);
  const TAIL_LIMIT = Math.max(0, limit - HEAD_LIMIT);

  const { data: headData } = await supabaseAdmin
    .from("emails")
    // body_text / body_html plaintext columns are zeroed by the
    // emails_encrypt_body trigger after the first write; we only need
    // to know whether body content EXISTS, so we read the encrypted-
    // column presence instead.
    .select("id, gmail_message_id, raw_labels, from_addr, subject, body_text, body_html, received_at, folder_id")
    .eq("gmail_account_id", accountId)
    .eq("is_archived", false)
    .order("received_at", { ascending: false, nullsFirst: true })
    .limit(HEAD_LIMIT);

  type RecRow = NonNullable<typeof headData>[number];
  let tailData: RecRow[] = [];
  if (TAIL_LIMIT > 0) {
    // Anchor the tail walk so it never overlaps the head. When cursor
    // is null (first run, or after wrap-around), use the OLDEST
    // received_at from the head — guarantees zero duplicates.
    const headOldest = (headData ?? [])
      .map((r) => r.received_at)
      .filter((x): x is string => !!x)
      .sort()[0] ?? null;
    const tailAnchor = cursor ?? headOldest;
    let q = supabaseAdmin
      .from("emails")
      // body_text / body_html plaintext columns are zeroed by the
    // emails_encrypt_body trigger after the first write; we only need
    // to know whether body content EXISTS, so we read the encrypted-
    // column presence instead.
    .select("id, gmail_message_id, raw_labels, from_addr, subject, body_text, body_html, received_at, folder_id")
      .eq("gmail_account_id", accountId)
      .eq("is_archived", false);
    if (tailAnchor) q = q.lt("received_at", tailAnchor);
    const { data } = await q
      .order("received_at", { ascending: false, nullsFirst: false })
      .limit(TAIL_LIMIT);
    tailData = (data ?? []) as RecRow[];
  }

  const rows: RecRow[] = [...(headData ?? []), ...tailData];

  // Advance the cursor to the oldest received_at we just touched in
  // the tail window. If we ran out (no tail rows older than cursor),
  // reset to null so the next tick starts from the top again.
  let newCursor: string | null = cursor;
  if (TAIL_LIMIT > 0) {
    const oldest = tailData.reduce<string | null>((acc, r) => {
      if (!r.received_at) return acc;
      return !acc || r.received_at < acc ? r.received_at : acc;
    }, null);
    if (oldest) {
      newCursor = oldest;
    } else if (cursor) {
      newCursor = null;
    }
  }
  if (newCursor !== cursor) {
    try {
      await supabaseAdmin
        .from("gmail_accounts")
        .update({ reconcile_cursor: newCursor })
        .eq("id", accountId);
    } catch (e) { logError("reconcile.cursor_update_failed", { account_id: accountId, new_cursor: newCursor }, e); }
  }

  let archived = 0;
  let deleted = 0;
  let updated = 0;
  let repaired = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const needsRepair =
        !row.from_addr ||
        !row.subject ||
        (!row.body_text && !row.body_html) ||
        !row.received_at;

      if (needsRepair) {
        try {
          const raw = await getMessage(accountId, row.gmail_message_id);
          const parsed = parseMessage(raw);
          const inTrash = parsed.raw_labels?.includes("TRASH");
          if (inTrash) {
            await supabaseAdmin.from("emails").delete().eq("id", row.id);
            deleted++;
            continue;
          }
          await supabaseAdmin.from("emails").update({
            from_addr: parsed.from_addr,
            from_name: parsed.from_name,
            to_addrs: parsed.to_addrs,
            subject: parsed.subject,
            snippet: parsed.snippet,
            body_text: parsed.body_text,
            body_html: parsed.body_html,
            received_at: parsed.received_at,
            has_attachment: parsed.has_attachment,
            raw_labels: parsed.raw_labels,
            is_read: parsed.is_read,
            is_archived: !parsed.raw_labels?.includes("INBOX"),
          }).eq("id", row.id);
          if (!parsed.raw_labels?.includes("INBOX")) archived++;
          repaired++;
          continue;
        } catch (e: unknown) {
          const msg = (e as Error)?.message ?? "";
          if (typeof msg === "string" && msg.includes("404")) {
            await supabaseAdmin.from("emails").delete().eq("id", row.id);
            deleted++;
            continue;
          }
          throw e;
        }
      }

      const labels = await getMessageLabels(accountId, row.gmail_message_id);
      if (labels === null) {
        await supabaseAdmin.from("emails").delete().eq("id", row.id);
        deleted++;
        continue;
      }
      const patch: { raw_labels?: string[]; is_archived?: boolean; is_read?: boolean } = {};
      const inInbox = labels.includes("INBOX");
      const inTrash = labels.includes("TRASH");
      if (inTrash) {
        await supabaseAdmin.from("emails").delete().eq("id", row.id);
        deleted++;
        continue;
      }
      if (!inInbox) {
        patch.is_archived = true;
        archived++;
      }
      patch.raw_labels = labels;
      patch.is_read = !labels.includes("UNREAD");
      await supabaseAdmin.from("emails").update(patch).eq("id", row.id);
      if (!patch.is_archived) updated++;
    } catch (e) {
      failed++;
      logError("reconcile.row_failed", { account_id: accountId, gmail_message_id: row.gmail_message_id, email_id: row.id, pass: "head_tail" }, e);
    }
  }

  // Second pass: scan the most recent archived rows for "moved back to
  // inbox in Gmail" or "marked unread in Gmail" changes that the
  // history poll missed. Cheap label-only fetches.
  let unarchived = 0;
  const { data: archivedRows } = await supabaseAdmin
    .from("emails")
    .select("id, gmail_message_id, raw_labels, is_read, folder_id")
    .eq("gmail_account_id", accountId)
    .eq("is_archived", true)
    .order("received_at", { ascending: false, nullsFirst: false })
    .limit(200);
  for (const row of archivedRows ?? []) {
    try {
      const labels = await getMessageLabels(accountId, row.gmail_message_id);
      if (labels === null) {
        await supabaseAdmin.from("emails").delete().eq("id", row.id);
        deleted++;
        continue;
      }
      if (labels.includes("TRASH")) {
        await supabaseAdmin.from("emails").delete().eq("id", row.id);
        deleted++;
        continue;
      }
      const inInbox = labels.includes("INBOX");
      const unread = labels.includes("UNREAD");
      const patch: { raw_labels?: string[]; is_archived?: boolean; is_read?: boolean } = {
        raw_labels: labels,
      };
      if (inInbox) {
        patch.is_archived = false;
        unarchived++;
      }
      if (row.is_read !== !unread) {
        patch.is_read = !unread;
      }
      await supabaseAdmin.from("emails").update(patch).eq("id", row.id);
    } catch (e) {
      failed++;
      logError("reconcile.row_failed", { account_id: accountId, gmail_message_id: row.gmail_message_id, email_id: row.id, pass: "archived" }, e);
    }
  }

  return {
    checked: rows.length,
    archived,
    deleted,
    updated,
    repaired,
    failed,
    archived_checked: archivedRows?.length ?? 0,
    unarchived,
  };
}
