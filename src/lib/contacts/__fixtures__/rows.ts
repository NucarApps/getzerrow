// Typed row factories for the contacts suites.
//
// Every factory returns a COMPLETE `Database["public"]["Tables"][T]["Row"]`,
// so a column renamed or added by a migration breaks the factory once
// instead of silently seeding `undefined` into fifty tests. Callers pass a
// partial override; excess keys are a type error.
//
// Use these instead of ad-hoc object literals whenever a test needs a row
// that some production code will *read fields off* — the seeded row then
// has the same shape the database would hand back. Seeding a deliberately
// sparse row (`fake.seed("contacts", [{ id, user_id }])`) is still fine
// when the test only cares about the filter.
//
// Lives in __fixtures__ so it is excluded from the coverage/test globs and
// never ships.
import type { Database } from "@/integrations/supabase/types";
import type { SupabaseFake } from "@/lib/__fixtures__/supabase-fake";
import type { supabaseAdmin } from "@/integrations/supabase/client.server";

type Tables = Database["public"]["Tables"];
type Row<T extends keyof Tables> = Tables[T]["Row"];

/** Fixed timestamps so payload assertions can be exact. */
export const FIXTURE_NOW = "2026-01-01T00:00:00.000Z";

export function makeContactRow(over: Partial<Row<"contacts">> = {}): Row<"contacts"> {
  return {
    address_line1_enc: null,
    address_line2_enc: null,
    ai_category: null,
    avatar_source: "none",
    avatar_url: null,
    card_image_url: null,
    city: null,
    company: null,
    company_id: null,
    company_logo_photo_sha: null,
    country: null,
    created_at: FIXTURE_NOW,
    email: "ada@acme.com",
    enriched_at: null,
    id: "contact-1",
    key_version: 1,
    linkedin: null,
    manual_overrides: [],
    name: "Ada Lovelace",
    notes_enc: null,
    phone_enc: null,
    photo_priority: null,
    postal_code: null,
    region: null,
    relationship_summary_enc: null,
    source: "manual",
    summary_generated_at: null,
    title: null,
    twitter: null,
    updated_at: FIXTURE_NOW,
    user_id: "test-user-1",
    website: null,
    ...over,
  };
}

export function makeContactEmailRow(
  over: Partial<Row<"contact_emails">> = {},
): Row<"contact_emails"> {
  return {
    address: "ada@acme.com",
    contact_id: "contact-1",
    created_at: FIXTURE_NOW,
    id: "contact-email-1",
    is_primary: true,
    label: "work",
    position: 0,
    updated_at: FIXTURE_NOW,
    user_id: "test-user-1",
    ...over,
  };
}

export function makeContactPhoneRow(
  over: Partial<Row<"contact_phones">> = {},
): Row<"contact_phones"> {
  return {
    contact_id: "contact-1",
    created_at: FIXTURE_NOW,
    id: "contact-phone-1",
    is_primary: true,
    label: "mobile",
    number: "+15550001111",
    position: 0,
    updated_at: FIXTURE_NOW,
    user_id: "test-user-1",
    ...over,
  };
}

export function makeGroupRow(over: Partial<Row<"contact_groups">> = {}): Row<"contact_groups"> {
  return {
    auto_company_subgroups: false,
    auto_generated_from_group_id: null,
    carddav_uid: "group-uid-1",
    color: "#888888",
    created_at: FIXTURE_NOW,
    folder_id: null,
    id: "group-1",
    kind: "manual",
    name: "Group One",
    parent_group_id: null,
    updated_at: FIXTURE_NOW,
    user_id: "test-user-1",
    ...over,
  };
}

export function makeGroupMemberRow(
  over: Partial<Row<"contact_group_members">> = {},
): Row<"contact_group_members"> {
  return {
    auto_added: false,
    contact_id: "contact-1",
    created_at: FIXTURE_NOW,
    group_id: "group-1",
    source: null,
    user_id: "test-user-1",
    ...over,
  };
}

export function makeSuggestionRow(
  over: Partial<Row<"contact_enrichment_suggestions">> = {},
): Row<"contact_enrichment_suggestions"> {
  return {
    confidence: "high",
    contact_id: "contact-1",
    created_at: FIXTURE_NOW,
    evidence: null,
    field: "company",
    id: "suggestion-1",
    run_id: "run-1",
    source: "email_signature",
    status: "pending",
    updated_at: FIXTURE_NOW,
    user_id: "test-user-1",
    value: "Acme",
    ...over,
  };
}

/** The fake's client under the type the `*Impl` helpers declare for their
 * injected client (`typeof supabaseAdmin`). The fake implements the subset
 * production code actually calls; this is the ONE place that cast lives, so
 * test bodies stay assertion-only. */
export function asSupabaseAdmin(fake: SupabaseFake): typeof supabaseAdmin {
  return fake.supabaseAdmin as unknown as typeof supabaseAdmin;
}
