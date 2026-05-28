// Folder example collection + profile regeneration. Five entry points
// that together implement "let the AI classifier learn from the user's
// labels":
//
//   recordManualMove           Called from history sync when the user
//                              manually labels a message in Gmail.
//                              Promotes the row to the folder + appends
//                              a folder_example.
//   regenerateFolderProfile    Asks the AI to summarize the folder's
//                              examples into a learned_profile blob.
//                              Called auto when ≥3 manual moves
//                              accumulate, or via the relearn cron.
//   bumpEmailsSinceLearn       Increments the per-folder counter the
//                              auto-relearn cron uses to decide which
//                              folders are due.
//   learnFromLinkedLabel       Seeds a folder's examples from a Gmail
//                              label (one-time on link). Pulls both
//                              local rows already in the folder AND up
//                              to 200 Gmail-side label members.
//   loadOlderFromLabel         "Pull the NEXT page of older labeled
//                              messages from Gmail" — for the inbox UI's
//                              "load older" button. Walks backwards via
//                              page tokens stored on the folder row.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { buildFolderProfile } from "../ai.server";
import { listMessages, getMessageMetadata, parseMessage } from "../gmail.server";
import type { Folder } from "./types";
import { logError } from "../log.server";
import { insertFolderExampleEncrypted, upsertEmailEncrypted, updateEmailEncrypted } from "./encrypted-writer";

/** Promote an email to a folder + record a "manual_move" example.
 * Skips the example/promotion when the row was ALREADY in this folder
 * with a non-manual classification (i.e. Gmail is just echoing back a
 * label we already applied). */
export async function recordManualMove(
  folder: Folder,
  accountId: string,
  userId: string,
  msg: { gmail_message_id: string; from_addr: string; subject: string; snippet: string },
): Promise<void> {
  const { data: existingRow } = await supabaseAdmin
    .from("emails")
    .select("folder_id, classified_by")
    .eq("gmail_message_id", msg.gmail_message_id)
    .eq("gmail_account_id", accountId)
    .maybeSingle();
  if (
    existingRow &&
    existingRow.folder_id === folder.id &&
    ["ai", "filter", "gmail_label", "domain_rule", "manual_move"].includes(
      existingRow.classified_by ?? "",
    )
  ) {
    return;
  }

  const { error } = await insertFolderExampleEncrypted({
    folder_id: folder.id,
    gmail_account_id: accountId,
    user_id: userId,
    gmail_message_id: msg.gmail_message_id,
    from_addr: msg.from_addr,
    subject: msg.subject,
    snippet: msg.snippet,
    source: "manual_move",
  });
  if (error) logError("folder_learn.example_upsert_failed", { folder_id: folder.id, account_id: accountId, gmail_message_id: msg.gmail_message_id }, { message: error });

  await supabaseAdmin
    .from("emails")
    .update({
      folder_id: folder.id,
      classified_by: "manual_move",
      ai_confidence: 1,
      classification_reason: `Moved to "${folder.name}" manually in Gmail`,
    })
    .eq("gmail_message_id", msg.gmail_message_id)
    .eq("gmail_account_id", accountId);

  // Trigger auto-relearn when ≥3 manual moves have piled up since the
  // last learn. The AI profile only consumes 50 examples, so frequent
  // relearn keeps it tracking the user's recent intent.
  const since = folder.last_learned_at ?? "1970-01-01T00:00:00Z";
  const { count } = await supabaseAdmin
    .from("folder_examples")
    .select("id", { count: "exact", head: true })
    .eq("folder_id", folder.id)
    .eq("source", "manual_move")
    .gt("created_at", since);
  if ((count ?? 0) >= 3) {
    try { await regenerateFolderProfile(folder.id); }
    catch (e) { logError("folder_learn.auto_relearn_failed", { folder_id: folder.id }, e); }
  }
}

/** Build (and persist) a fresh AI-summarized profile for a folder from
 * its 50 newest examples. Returns the generated profile text. */
export async function regenerateFolderProfile(folderId: string): Promise<string | undefined> {
  const { data: folder } = await supabaseAdmin
    .from("folders")
    .select("*")
    .eq("id", folderId)
    .single();
  if (!folder) return;
  const { data: examples } = await supabaseAdmin
    .from("folder_examples")
    .select("from_addr, subject, snippet")
    .eq("folder_id", folderId)
    .order("created_at", { ascending: false })
    .limit(50);
  const profile = await buildFolderProfile(folder.name, folder.ai_rule, examples ?? []);
  await supabaseAdmin
    .from("folders")
    .update({
      learned_profile: profile,
      last_learned_at: new Date().toISOString(),
      emails_since_learn: 0,
    })
    .eq("id", folderId);
  return profile;
}

/** Increment the per-folder "new emails since last learn" counter so
 * the auto-relearn cron knows which folders to refresh. Best-effort —
 * errors are swallowed so they never block classification. */
export async function bumpEmailsSinceLearn(folderId: string): Promise<void> {
  try {
    const { data: row } = await supabaseAdmin
      .from("folders")
      .select("emails_since_learn")
      .eq("id", folderId)
      .maybeSingle();
    if (!row) return;
    await supabaseAdmin
      .from("folders")
      .update({ emails_since_learn: (row.emails_since_learn ?? 0) + 1 })
      .eq("id", folderId);
  } catch (e) {
    logError("folder_learn.bump_failed", { folder_id: folderId }, e);
  }
}

/** Bulk-seed a folder's examples from a linked Gmail label.
 *
 *   Source A: local emails already routed here (cheap — no Gmail fetch).
 *   Source B: Gmail messages currently bearing the label (metadata
 *             fetch, up to 200, pool of 10 in parallel).
 *
 * After seeding, regenerates the folder profile so the AI classifier
 * picks up the new examples on its next pass. */
export async function learnFromLinkedLabel(folderId: string, userId: string) {
  const { data: folderRow } = await supabaseAdmin
    .from("folders")
    .select("*")
    .eq("id", folderId)
    .single();
  if (!folderRow) throw new Error("Folder not found");
  const folder = folderRow;
  if (folder.user_id !== userId) throw new Error("Not authorized");
  if (!folder.gmail_label_id) throw new Error("Folder is not linked to a Gmail label");
  const accountId = folder.gmail_account_id;

  const MAX_MESSAGES = 200;
  const list = await listMessages(accountId, {
    maxResults: MAX_MESSAGES,
    labelIds: [folder.gmail_label_id],
  });
  const gmailIds = (list.messages ?? []).map((m) => m.id).slice(0, MAX_MESSAGES);

  const { data: localRows } = await supabaseAdmin
    .from("emails")
    .select("gmail_message_id, from_addr, subject, snippet")
    .eq("folder_id", folderId)
    .order("received_at", { ascending: false })
    .limit(MAX_MESSAGES);

  const candidateIds = Array.from(new Set([
    ...gmailIds,
    ...(localRows ?? []).map((r) => r.gmail_message_id),
  ]));
  let knownSet = new Set<string>();
  if (candidateIds.length > 0) {
    const { data: known } = await supabaseAdmin
      .from("folder_examples")
      .select("gmail_message_id")
      .eq("folder_id", folderId)
      .in("gmail_message_id", candidateIds);
    knownSet = new Set((known ?? []).map((r) => r.gmail_message_id));
  }

  let learned = 0;
  let ingested = 0;
  let claimed = 0;

  // Seed from local rows first (no Gmail roundtrip).
  const seededFromLocal = new Set<string>();
  for (const row of localRows ?? []) {
    if (knownSet.has(row.gmail_message_id)) continue;
    const { error } = await insertFolderExampleEncrypted({
      folder_id: folderId,
      gmail_account_id: accountId,
      user_id: userId,
      gmail_message_id: row.gmail_message_id,
      from_addr: row.from_addr,
      subject: row.subject,
      snippet: row.snippet,
      source: "seed",
    });
    if (!error) {
      learned++;
      seededFromLocal.add(row.gmail_message_id);
    }
  }

  const idsToFetch = gmailIds.filter((id) => !knownSet.has(id) && !seededFromLocal.has(id));

  const CONCURRENCY = 10;
  async function processOne(id: string) {
    try {
      const raw = await getMessageMetadata(accountId, id);
      const p = parseMessage(raw);
      const { error } = await insertFolderExampleEncrypted({
        folder_id: folderId,
        gmail_account_id: accountId,
        user_id: userId,
        gmail_message_id: p.gmail_message_id,
        from_addr: p.from_addr,
        subject: p.subject,
        snippet: p.snippet,
        source: "seed",
      });
      if (!error) learned++;

      // Tag a local email if it exists; insert a lightweight row otherwise.
      // body_text/body_html intentionally omitted — the normal sync flow
      // fills those in when the message arrives via push or backfill.
      const { data: existing } = await supabaseAdmin
        .from("emails")
        .select("id, folder_id")
        .eq("gmail_message_id", p.gmail_message_id)
        .maybeSingle();
      if (existing) {
        if (existing.folder_id !== folderId) {
          await updateEmailEncrypted({
            email_id: existing.id,
            folder_id: folderId,
            classified_by: "gmail_label",
            ai_confidence: 1,
            classification_reason: `Matched Gmail label "${folder.name}"`,
          });
          claimed++;
        }
      } else {
        const { id: newId, error: insErr } = await upsertEmailEncrypted({
          user_id: userId,
          gmail_account_id: accountId,
          gmail_message_id: p.gmail_message_id,
          thread_id: p.thread_id,
          from_addr: p.from_addr,
          from_name: p.from_name,
          to_addrs: p.to_addrs,
          cc: null,
          list_id: null,
          in_reply_to: null,
          subject: p.subject,
          snippet: p.snippet,
          body_text: null,
          body_html: null,
          received_at: p.received_at,
          is_read: p.is_read,
          is_archived: !p.raw_labels?.includes("INBOX"),
          has_attachment: p.has_attachment,
          raw_labels: p.raw_labels,
          classified_by: "gmail_label",
          processed_at: null,
          published_at_ms: null,
        });
        if (!insErr) {
          ingested++;
          if (newId) {
            await updateEmailEncrypted({
              email_id: newId,
              folder_id: folderId,
              ai_confidence: 1,
              classification_reason: `Matched Gmail label "${folder.name}"`,
            });
          }
        }
        else logError("folder_learn.ingest_failed", { folder_id: folderId, account_id: accountId, gmail_message_id: p.gmail_message_id }, { message: insErr });
      }
    } catch (e) {
      logError("folder_learn.seed_example_failed", { folder_id: folderId, account_id: accountId, gmail_message_id: id }, e);
    }
  }

  for (let i = 0; i < idsToFetch.length; i += CONCURRENCY) {
    const chunk = idsToFetch.slice(i, i + CONCURRENCY);
    await Promise.all(chunk.map(processOne));
  }

  const profile = await regenerateFolderProfile(folderId);
  return { learned, ingested, claimed, profile };
}

/** Pagination-driven "load older messages from a linked label" — used
 * by the inbox UI's "load older" button. Walks backwards via a Gmail
 * pageToken cached on the folder row, falling back to a date-anchored
 * `before:` query when the cached token doesn't apply. */
export async function loadOlderFromLabel(
  folderId: string,
  userId: string,
  beforeReceivedAt: string | null,
) {
  const { data: folderRow } = await supabaseAdmin
    .from("folders")
    .select(
      "id, user_id, name, gmail_label_id, gmail_account_id, gmail_backfill_page_token, gmail_backfill_oldest_received_at",
    )
    .eq("id", folderId)
    .single();
  if (!folderRow) throw new Error("Folder not found");
  const folder = folderRow;
  if (folder.user_id !== userId) throw new Error("Not authorized");
  if (!folder.gmail_label_id) {
    return { ingested: 0, hasMore: false, reason: "no_label" as const };
  }

  // Prefer the stored pageToken when it lines up with the caller's
  // cursor. Otherwise fall back to a Gmail `before:` query anchored
  // to the cursor, so we always retrieve messages older than what's
  // local.
  let pageToken: string | undefined;
  let q: string | undefined;
  const tokenUsable =
    beforeReceivedAt &&
    folder.gmail_backfill_oldest_received_at &&
    new Date(beforeReceivedAt).getTime() <=
      new Date(folder.gmail_backfill_oldest_received_at).getTime() &&
    folder.gmail_backfill_page_token;
  if (tokenUsable) {
    pageToken = folder.gmail_backfill_page_token!;
  } else if (beforeReceivedAt) {
    const secs = Math.floor(new Date(beforeReceivedAt).getTime() / 1000);
    q = `before:${secs}`;
  }

  const list = await listMessages(folder.gmail_account_id, {
    labelIds: [folder.gmail_label_id],
    maxResults: 50,
    pageToken,
    q,
  });
  const ids = (list.messages ?? []).map((m) => m.id);
  let ingested = 0;
  let claimed = 0;
  let oldestSeen: string | null = null;

  if (ids.length > 0) {
    const { data: existing } = await supabaseAdmin
      .from("emails")
      .select("id, gmail_message_id, folder_id, received_at")
      .in("gmail_message_id", ids);
    const known = new Map(
      (existing ?? []).map((r) => [r.gmail_message_id, r] as const),
    );
    for (const r of existing ?? []) {
      if (r.received_at && (!oldestSeen || r.received_at < oldestSeen)) {
        oldestSeen = r.received_at;
      }
    }

    const CONCURRENCY = 8;
    async function processOne(id: string) {
      try {
        const k = known.get(id);
        if (k) {
          if (k.folder_id !== folderId) {
            await updateEmailEncrypted({
              email_id: k.id,
              folder_id: folderId,
              classified_by: "gmail_label",
              ai_confidence: 1,
              classification_reason: `Matched Gmail label "${folder.name}"`,
            });
            claimed++;
          }
          return;
        }
        const raw = await getMessageMetadata(folder.gmail_account_id, id);
        const p = parseMessage(raw);
        const { id: newId, error } = await upsertEmailEncrypted({
          user_id: userId,
          gmail_account_id: folder.gmail_account_id,
          gmail_message_id: p.gmail_message_id,
          thread_id: p.thread_id,
          from_addr: p.from_addr,
          from_name: p.from_name,
          to_addrs: p.to_addrs,
          cc: null,
          list_id: null,
          in_reply_to: null,
          subject: p.subject,
          snippet: p.snippet,
          body_text: null,
          body_html: null,
          received_at: p.received_at,
          is_read: p.is_read,
          is_archived: !p.raw_labels?.includes("INBOX"),
          has_attachment: p.has_attachment,
          raw_labels: p.raw_labels,
          classified_by: "gmail_label",
          processed_at: null,
          published_at_ms: null,
        });
        if (!error) {
          ingested++;
          if (newId) {
            await updateEmailEncrypted({
              email_id: newId,
              folder_id: folderId,
              ai_confidence: 1,
              classification_reason: `Matched Gmail label "${folder.name}"`,
            });
          }
          if (p.received_at && (!oldestSeen || p.received_at < oldestSeen)) {
            oldestSeen = p.received_at;
          }
        }
      } catch (e) {
        logError("folder_learn.load_older_one_failed", { folder_id: folderId, account_id: folder.gmail_account_id, gmail_message_id: id }, e);
      }
    }
    for (let i = 0; i < ids.length; i += CONCURRENCY) {
      await Promise.all(ids.slice(i, i + CONCURRENCY).map(processOne));
    }
  }

  // If we used a stale pageToken and got nothing new, clear it so the
  // next click falls through to the date-anchored query path.
  const clearStaleToken = !!pageToken && ingested === 0 && claimed === 0;

  const hasMore = !!list.nextPageToken;
  await supabaseAdmin
    .from("folders")
    .update({
      gmail_backfill_page_token: clearStaleToken ? null : (list.nextPageToken ?? null),
      gmail_backfill_oldest_received_at:
        oldestSeen ?? folder.gmail_backfill_oldest_received_at ?? null,
    })
    .eq("id", folderId);

  return { ingested, claimed, hasMore };
}
