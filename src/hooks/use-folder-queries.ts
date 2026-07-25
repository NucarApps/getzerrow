import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { FOLDER_COLUMNS } from "@/components/folders/editor/types";
import { listGmailLabels } from "@/lib/gmail.functions";

/**
 * The authenticated shell and the inbox route both need the account's folders
 * and its Gmail labels, and both already used the same query keys so they share
 * one cache entry. The queryFns, however, were copy-pasted between the two —
 * meaning the *cache* was shared but the fetch could silently drift.
 *
 * Generic over the row type because the two call sites cast to their own local
 * Folder aliases; the selected columns (FOLDER_COLUMNS) are the same either way.
 */
export function useFoldersFullQuery<T>(accountId: string | null | undefined) {
  return useQuery({
    queryKey: ["folders-full", accountId],
    enabled: !!accountId,
    queryFn: async () => {
      const { data } = await supabase
        .from("folders")
        .select(FOLDER_COLUMNS)
        .eq("gmail_account_id", accountId!)
        .order("name", { ascending: true });
      return (data ?? []) as T[];
    },
  });
}

/**
 * Gmail labels for the account. Swallows the error and returns an empty list:
 * labels are an enhancement (linking a folder to an existing Gmail label), so a
 * failed fetch must not take down the surrounding screen.
 */
export function useGmailLabelsQuery<T>(accountId: string | null | undefined) {
  const listLabelsFn = useServerFn(listGmailLabels);
  return useQuery({
    queryKey: ["gmail-labels", accountId],
    enabled: !!accountId,
    queryFn: async () => {
      try {
        return (await listLabelsFn({ data: { account_id: accountId! } })).labels as T[];
      } catch {
        return [] as T[];
      }
    },
  });
}
