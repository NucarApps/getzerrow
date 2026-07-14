import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { generateText, Output } from "ai";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { sendContactShareEmail } from "../cards.server";
import { setContactEncryptedFields } from "../sync/encrypted-writer";
import {
  getContactDecrypted,
  getContactListFieldsDecrypted,
  getEmailsDecrypted,
} from "../sync/encrypted-reader";
import {
  fetchFromGmail,
  getModel,
  EXTRACT_SCHEMA,
  ADDRESS_FIELDS,
  isLikelyHuman,
  normalizeName,
  firstNameKey,
  pickBetterName,
  phoneEntrySchema,
} from "../contacts-helpers.server";

export const shareContactByEmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        contactId: z.string().uuid(),
        toEmail: z.string().email(),
        note: z.string().max(2000).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { userId } = context;

    // phone / address_line1 / address_line2 live in encrypted columns only —
    // read the full decrypted row via SECURITY DEFINER RPC.
    const { row: contact, error } = await getContactDecrypted(data.contactId);
    if (error) throw new Error(error);
    if (!contact || contact.user_id !== userId) throw new Error("Contact not found");

    const { data: account } = await supabaseAdmin
      .from("gmail_accounts")
      .select("id, email_address")
      .eq("user_id", userId)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!account) throw new Error("Connect your Gmail account in Settings first.");

    await sendContactShareEmail({
      accountId: account.id,
      fromEmail: account.email_address,
      toEmail: data.toEmail,
      contact: {
        name: contact.name,
        title: contact.title,
        company: contact.company,
        email: contact.email,
        phone: contact.phone,
        website: contact.website,
        linkedin: contact.linkedin,
        twitter: contact.twitter,
        address_line1: contact.address_line1,
        address_line2: contact.address_line2,
        city: contact.city,
        region: contact.region,
        postal_code: contact.postal_code,
        country: contact.country,
      },
      note: data.note ?? null,
    });

    return { ok: true };
  });
export const listFoldersForPicker = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    const { data, error } = await supabase
      .from("folders")
      .select("id,name,color")
      .order("priority", { ascending: false })
      .order("name", { ascending: true });
    if (error) throw new Error(error.message);
    return { folders: data ?? [] };
  });
export const listUniqueInboxSenders = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        folderIds: z.array(z.string().uuid()).max(50).optional(),
        search: z.string().trim().max(200).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      })
      .parse(d ?? {}),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    // Pull a chunk of recent emails (cap at 5k to keep aggregation fast).
    let q = supabase
      .from("emails")
      .select("id,from_addr,received_at,folder_id")
      .eq("user_id", userId)
      .not("from_addr", "is", null)
      .order("received_at", { ascending: false })
      .limit(5000);
    if (data.folderIds && data.folderIds.length > 0) {
      q = q.in("folder_id", data.folderIds);
    }
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);

    // Existing contact addresses (to exclude).
    const { data: existing } = await supabaseAdmin
      .from("contacts")
      .select("email")
      .eq("user_id", userId);
    const existingSet = new Set((existing ?? []).map((c) => (c.email || "").toLowerCase()));

    type Agg = { email: string; name: string | null; count: number; lastReceivedAt: string | null };
    const agg = new Map<string, Agg>();
    for (const r of rows ?? []) {
      const addr = (r.from_addr || "").trim().toLowerCase();
      if (!addr || !isLikelyHuman(addr)) continue;
      if (existingSet.has(addr)) continue;
      const cur = agg.get(addr);
      const nm = normalizeName(null);
      if (!cur) {
        agg.set(addr, { email: addr, name: nm, count: 1, lastReceivedAt: r.received_at ?? null });
      } else {
        cur.count++;
        if (nm && (!cur.name || nm.length > cur.name.length)) cur.name = nm;
        if (r.received_at && (!cur.lastReceivedAt || r.received_at > cur.lastReceivedAt)) {
          cur.lastReceivedAt = r.received_at;
        }
      }
    }

    let list = [...agg.values()];
    const search = (data.search || "").toLowerCase().trim();
    if (search) {
      list = list.filter(
        (x) => x.email.includes(search) || (x.name ?? "").toLowerCase().includes(search),
      );
    }
    list.sort((a, b) => b.count - a.count);
    const limit = data.limit ?? 200;
    return { senders: list.slice(0, limit) };
  });
