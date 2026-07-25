import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

/**
 * A Supabase client typed against the generated schema.
 *
 * Helper functions that take a caller-supplied client (RLS-scoped from a
 * server-fn context, or the admin client) annotate the parameter with this
 * instead of each module re-declaring the same alias.
 */
export type DB = SupabaseClient<Database>;
