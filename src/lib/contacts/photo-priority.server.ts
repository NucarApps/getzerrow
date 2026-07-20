// Photo priority resolver: decides whether the personal photo, the company
// logo, or initials should represent a contact — across the Zerrow UI, iOS
// CardDAV, and Google People push. Precedence: contact override > company
// override > global default (default = company_first).

export type PhotoPriority = "company_first" | "personal_first" | "personal_only";
export type PhotoPrioritySource = "contact" | "company" | "global" | "default";

export function resolveEffectivePriority(args: {
  contactPriority?: PhotoPriority | null;
  companyPriority?: PhotoPriority | null;
  globalPriority?: PhotoPriority | null;
}): { priority: PhotoPriority; source: PhotoPrioritySource } {
  if (args.contactPriority) return { priority: args.contactPriority, source: "contact" };
  if (args.companyPriority) return { priority: args.companyPriority, source: "company" };
  if (args.globalPriority) return { priority: args.globalPriority, source: "global" };
  return { priority: "company_first", source: "default" };
}

/** Read the caller's effective photo priority for a specific contact.
 *  Loads global (carddav_settings), company override (companies), and
 *  contact override (contacts) in a single admin round-trip. */
export async function getEffectivePhotoPriority(
  userId: string,
  contactId: string,
): Promise<{ priority: PhotoPriority; source: PhotoPrioritySource; companyId: string | null }> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: contact } = await supabaseAdmin
    .from("contacts")
    .select("company_id, photo_priority")
    .eq("id", contactId)
    .eq("user_id", userId)
    .maybeSingle();
  const c = contact as { company_id?: string | null; photo_priority?: PhotoPriority | null } | null;
  const companyId = c?.company_id ?? null;

  let companyPriority: PhotoPriority | null = null;
  if (companyId) {
    const { data: company } = await supabaseAdmin
      .from("companies")
      .select("photo_priority")
      .eq("id", companyId)
      .eq("user_id", userId)
      .maybeSingle();
    companyPriority = (company as { photo_priority?: PhotoPriority | null } | null)?.photo_priority ?? null;
  }

  const { data: settings } = await supabaseAdmin
    .from("carddav_settings")
    .select("photo_priority")
    .eq("user_id", userId)
    .maybeSingle();
  const globalPriority =
    (settings as { photo_priority?: PhotoPriority | null } | null)?.photo_priority ?? null;

  const { priority, source } = resolveEffectivePriority({
    contactPriority: c?.photo_priority ?? null,
    companyPriority,
    globalPriority,
  });
  return { priority, source, companyId };
}
