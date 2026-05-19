import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { backfillRecent, syncSinceHistory } from "./sync.server";
import { listLabels, createLabel, modifyMessage, trashMessage, sendMessage, watchInbox, stopWatch } from "./gmail.server";
import { suggestReply } from "./ai.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const triggerBackfill = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { count?: number }) => d)
  .handler(async ({ data, context }) => {
    return backfillRecent(context.userId, Math.min(Math.max(data.count ?? 30, 1), 100));
  });

export const triggerSync = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    return syncSinceHistory(context.userId);
  });

export const createGmailLabel = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { name: string }) => d)
  .handler(async ({ data }) => {
    const labels = await listLabels();
    const existing = labels.labels?.find((l) => l.name === `Zerrow/${data.name}`);
    if (existing) return { id: existing.id };
    const created = await createLabel(`Zerrow/${data.name}`);
    return { id: created.id };
  });

export const markEmailRead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string; read: boolean }) => d)
  .handler(async ({ data }) => {
    const { data: email } = await supabaseAdmin.from("emails").select("gmail_message_id").eq("id", data.id).single();
    if (email) {
      try { await modifyMessage(email.gmail_message_id, [], data.read ? ["UNREAD"] : []); } catch (e) { console.error(e); }
      if (!data.read) {
        try { await modifyMessage(email.gmail_message_id, ["UNREAD"], []); } catch (e) { console.error(e); }
      }
    }
    await supabaseAdmin.from("emails").update({ is_read: data.read }).eq("id", data.id);
    return { ok: true };
  });

export const archiveEmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => d)
  .handler(async ({ data }) => {
    const { data: email } = await supabaseAdmin.from("emails").select("gmail_message_id").eq("id", data.id).single();
    if (email) {
      try { await modifyMessage(email.gmail_message_id, [], ["INBOX"]); } catch (e) { console.error(e); }
    }
    await supabaseAdmin.from("emails").update({ is_archived: true }).eq("id", data.id);
    return { ok: true };
  });

export const trashEmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => d)
  .handler(async ({ data }) => {
    const { data: email } = await supabaseAdmin.from("emails").select("gmail_message_id").eq("id", data.id).single();
    if (email) {
      try { await trashMessage(email.gmail_message_id); } catch (e) { console.error(e); }
    }
    await supabaseAdmin.from("emails").delete().eq("id", data.id);
    return { ok: true };
  });

export const generateReply = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => d)
  .handler(async ({ data, context }) => {
    const { data: email } = await supabaseAdmin
      .from("emails")
      .select("from_name, subject, body_text")
      .eq("id", data.id)
      .single();
    if (!email) throw new Error("Email not found");
    const draft = await suggestReply({
      from_name: email.from_name || "",
      subject: email.subject || "",
      body_text: email.body_text || "",
    });
    await supabaseAdmin.from("reply_drafts").insert({ email_id: data.id, user_id: context.userId, draft_text: draft });
    return { draft };
  });

export const sendReply = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string; body: string }) =>
    z.object({ id: z.string().uuid(), body: z.string().min(1).max(20000) }).parse(d)
  )
  .handler(async ({ data }) => {
    const { data: email } = await supabaseAdmin
      .from("emails")
      .select("from_addr, subject, thread_id, gmail_message_id")
      .eq("id", data.id)
      .single();
    if (!email) throw new Error("Email not found");
    const subject = email.subject?.startsWith("Re:") ? email.subject : `Re: ${email.subject ?? ""}`;
    await sendMessage(email.from_addr || "", subject, data.body, email.thread_id || undefined, email.gmail_message_id);
    return { ok: true };
  });

export const startGmailWatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { topic: string }) =>
    z.object({ topic: z.string().min(1).regex(/^projects\/[\w-]+\/topics\/[\w.-]+$/) }).parse(d)
  )
  .handler(async ({ data }) => {
    const r = await watchInbox(data.topic);
    await supabaseAdmin.from("sync_state").update({
      last_history_id: r.historyId,
      watch_expiration: new Date(parseInt(r.expiration, 10)).toISOString(),
    }).eq("id", 1);
    return r;
  });

export const stopGmailWatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    await stopWatch();
    await supabaseAdmin.from("sync_state").update({ watch_expiration: null }).eq("id", 1);
    return { ok: true };
  });

export const getSyncState = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { data } = await supabaseAdmin.from("sync_state").select("*").eq("id", 1).single();
    return data;
  });
