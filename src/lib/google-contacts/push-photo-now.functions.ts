// Server fns for "Sync to Google now" — forces an immediate photo push for
// a single contact or every member of a company. Marks the target link(s)
// photo-dirty (clears photo_etag + resets retry counter) and then triggers
// runGoogleContactsSync for each linked Gmail account so the change lands in
// Google People without waiting for the next cron tick.
import { createServerFn } from "@tanstack/react-start";
import { getRequestHost } from "@tanstack/react-start/server";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

type PushResult = {
  contactsMarked: number;
  accountsQueued: number;
  errors: string[];
};

async function assertOwnsContact(userId: string, contactId: string): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("contacts")
    .select("id")
    .eq("id", contactId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) throw new Error("Contact not found");
}

async function assertOwnsCompany(userId: string, companyId: string): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("companies")
    .select("id")
    .eq("id", companyId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) throw new Error("Company not found");
}

/** Fire-and-forget: kick the Google Contacts sync hook in the background so
 *  the "Sync now" server fn returns immediately. Awaiting runGoogleContactsSync
 *  inline can exceed Safari's fetch wall on large accounts (surfaces as
 *  "Load failed") and leaks the sync lease when the worker is killed. The
 *  hook endpoint runs in its own Worker request scoped by CRON_SECRET. */
function triggerBackgroundSync(): boolean {
  try {
    const host = getRequestHost();
    const cronSecret = process.env.CRON_SECRET;
    if (!host || !cronSecret) return false;
    // keepalive lets the outbound fetch outlive the parent response on Workers.
    void fetch(`https://${host}/api/public/hooks/google-contacts-sync`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cronSecret}`,
      },
      body: "{}",
      keepalive: true,
    }).catch(() => {
      // Non-fatal — the periodic cron will pick it up on the next tick.
    });
    return true;
  } catch {
    // Non-fatal — a missing host/secret just means the periodic cron handles it.
    return false;
  }
}

export const pushContactPhotoToGoogleNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ contactId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }): Promise<PushResult> => {
    await assertOwnsContact(context.userId, data.contactId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { markGooglePhotoDirty } = await import("./mark-dirty.server");

    // Pre-check with the exact resolver the Google push worker uses. This
    // includes the domain/company logo shown in Zerrow, not just stored photos.
    const { resolveEffectiveContactPhotoForSync } = await import("@/lib/contacts/logo-photo.server");
    const effectivePhoto = await resolveEffectiveContactPhotoForSync(context.userId, data.contactId);
    if (!effectivePhoto) {
      return {
        contactsMarked: 0,
        accountsSynced: 0,
        errors: ["no_photo_on_contact"],
      };
    }

    const { data: links } = await supabaseAdmin
      .from("google_contact_links")
      .select("gmail_account_id")
      .eq("user_id", context.userId)
      .eq("contact_id", data.contactId);
    const accountIds = Array.from(
      new Set(
        (links ?? [])
          .map((l) => (l as { gmail_account_id?: string }).gmail_account_id)
          .filter((v): v is string => !!v),
      ),
    );
    if (accountIds.length === 0) {
      return { contactsMarked: 0, accountsSynced: 0, errors: ["not_linked_to_google"] };
    }
    await markGooglePhotoDirty(context.userId, data.contactId);
    const { accountsSynced, errors } = await syncAccounts(context.userId, accountIds);
    return { contactsMarked: 1, accountsSynced, errors };
  });

export const pushCompanyPhotoToGoogleNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ companyId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }): Promise<PushResult> => {
    await assertOwnsCompany(context.userId, data.companyId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { markGooglePhotoDirtyMany } = await import("./mark-dirty.server");

    const { data: contacts } = await supabaseAdmin
      .from("contacts")
      .select("id")
      .eq("user_id", context.userId)
      .eq("company_id", data.companyId);
    const contactIds = (contacts ?? []).map((c) => (c as { id: string }).id);
    if (contactIds.length === 0) {
      return { contactsMarked: 0, accountsSynced: 0, errors: ["no_members"] };
    }

    const { data: links } = await supabaseAdmin
      .from("google_contact_links")
      .select("gmail_account_id")
      .eq("user_id", context.userId)
      .in("contact_id", contactIds);
    const accountIds = Array.from(
      new Set(
        (links ?? [])
          .map((l) => (l as { gmail_account_id?: string }).gmail_account_id)
          .filter((v): v is string => !!v),
      ),
    );
    if (accountIds.length === 0) {
      return { contactsMarked: 0, accountsSynced: 0, errors: ["not_linked_to_google"] };
    }
    await markGooglePhotoDirtyMany(context.userId, contactIds);
    const { accountsSynced, errors } = await syncAccounts(context.userId, accountIds);
    return { contactsMarked: contactIds.length, accountsSynced, errors };
  });
