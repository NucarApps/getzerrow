// Server fns for "Sync to Google now" — forces an immediate photo push for
// a single contact or every member of a company. Marks the target link(s)
// photo-dirty (clears photo_etag + resets retry counter) and then triggers
// runGoogleContactsSync for each linked Gmail account so the change lands in
// Google People without waiting for the next cron tick.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

type PushResult = {
  contactsMarked: number;
  accountsSynced: number;
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

/** Kick off runGoogleContactsSync for each linked Gmail account. Runs
 *  sequentially so we don't race on the per-account lease. Returns the count
 *  actually attempted plus any per-account errors (non-fatal to the request). */
async function syncAccounts(
  userId: string,
  accountIds: readonly string[],
): Promise<{ accountsSynced: number; errors: string[] }> {
  const { runGoogleContactsSync } = await import("./reconcile.server");
  const errors: string[] = [];
  let accountsSynced = 0;
  for (const accountId of accountIds) {
    try {
      const res = await runGoogleContactsSync(userId, accountId);
      if (res.ok) accountsSynced++;
      else if (res.error && res.error !== "locked") errors.push(res.error);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  return { accountsSynced, errors };
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
