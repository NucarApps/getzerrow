// Pure, Supabase-free scope logic shared by the inbox list views and the
// whole-mailbox search path. Kept here (instead of inline in the route file)
// so it can be unit-tested in isolation — the search path silently discarding
// archived/filed/replied hits once left the UI stuck on "Pulling N matches
// from Gmail…" forever, so this contract is pinned by tests in
// search-scope.test.ts.

// Classifications that mean a message is still being processed and is not yet
// safe to show in any list (it may move folders the moment the AI finishes).
export const IN_PROGRESS_CLASSIFICATIONS = new Set<string>(["pending", "pending_ai"]);

export type ScopeEmail = {
  classified_by: string | null;
  snoozed_until?: string | null;
  is_archived: boolean;
  folder_id: string | null;
  raw_labels?: string[] | null;
};

export type ScopeFolder = {
  id: string;
  auto_archive: boolean;
  hide_from_inbox: boolean;
};

export function isInProgressEmail(email: Pick<ScopeEmail, "classified_by">): boolean {
  return (
    typeof email.classified_by === "string" && IN_PROGRESS_CLASSIFICATIONS.has(email.classified_by)
  );
}

export function isSnoozed(email: Pick<ScopeEmail, "snoozed_until">): boolean {
  const snoozedMs = email.snoozed_until ? new Date(email.snoozed_until).getTime() : 0;
  return Boolean(snoozedMs && snoozedMs > Date.now());
}

export function emailBelongsInScope(
  email: ScopeEmail,
  selectedFolder: string,
  folders: ScopeFolder[],
): boolean {
  if (selectedFolder === "all_mail") return true;
  if (isInProgressEmail(email)) return false;
  if (isSnoozed(email)) return false;
  const labels = email.raw_labels ?? [];
  const folder = email.folder_id ? folders.find((f) => f.id === email.folder_id) : null;
  if (selectedFolder === "all") {
    return (
      email.is_archived !== true &&
      labels.includes("INBOX") &&
      !(folder?.auto_archive || folder?.hide_from_inbox)
    );
  }
  if (selectedFolder === "no_rules") {
    return email.folder_id === null && !labels.some((label) => label.startsWith("Label_"));
  }
  return email.folder_id === selectedFolder;
}

// Search spans the WHOLE mailbox, not the currently-selected inbox view. The
// server already ranks matches across archived, sent, and folder-filed mail,
// so we must not re-apply the inbox scope here — doing so silently discarded
// every archived/filed hit (e.g. a contact you email back and forth with) and
// left the UI stuck on "Pulling N matches from Gmail…" with nothing rendered.
// We only drop rows that genuinely aren't ready to show: still-classifying
// (in-progress) rows and currently-snoozed rows.
export function matchesSearchScope(email: ScopeEmail): boolean {
  if (isInProgressEmail(email)) return false;
  if (isSnoozed(email)) return false;
  return true;
}
