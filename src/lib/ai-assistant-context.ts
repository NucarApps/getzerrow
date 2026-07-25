// Pure, dependency-free helpers that shape the extra context the inbox
// assistant feeds to the model. Kept free of Supabase / server imports so
// they stay unit-testable and reusable from both the server function and
// tests.
import { emailDomain } from "./company-domains";

export type DomainCluster = {
  domain: string;
  count: number;
  // Where mail from this domain currently lands, most common first.
  folders: Array<{ name: string; count: number }>;
};

const INBOX_LABEL = "Inbox";

/** Aggregate recent emails by sender domain so the model can spot
 * "everything from acme.com should go to Clients" patterns without the
 * user hand-picking emails. Returns the busiest domains first. */
export function aggregateDomainClusters(
  rows: Array<{ from_addr: string | null; folder_id: string | null }>,
  folderNameById: Map<string, string>,
  opts?: { topN?: number; minCount?: number },
): DomainCluster[] {
  const topN = opts?.topN ?? 15;
  const minCount = opts?.minCount ?? 2;

  const byDomain = new Map<string, { count: number; folders: Map<string, number> }>();
  for (const row of rows) {
    const domain = emailDomain(row.from_addr);
    if (!domain) continue;
    let entry = byDomain.get(domain);
    if (!entry) {
      entry = { count: 0, folders: new Map() };
      byDomain.set(domain, entry);
    }
    entry.count += 1;
    const folderName = row.folder_id
      ? (folderNameById.get(row.folder_id) ?? INBOX_LABEL)
      : INBOX_LABEL;
    entry.folders.set(folderName, (entry.folders.get(folderName) ?? 0) + 1);
  }

  return Array.from(byDomain.entries())
    .filter(([, v]) => v.count >= minCount)
    .map(([domain, v]) => ({
      domain,
      count: v.count,
      folders: Array.from(v.folders.entries())
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, topN);
}

/** Find the folder a user's message most likely refers to by name. Matches
 * case-insensitively and prefers the longest folder name that appears in
 * the message (so "Client Invoices" beats "Clients"). Returns the folder id
 * or null when nothing matches. */
export function matchFolderByName(
  message: string,
  folders: Array<{ id: string; name: string }>,
): string | null {
  const haystack = message.toLowerCase();
  let bestId: string | null = null;
  let bestLen = 0;
  for (const f of folders) {
    const name = f.name.trim().toLowerCase();
    if (name.length < 3) continue; // too short to match reliably
    if (haystack.includes(name) && name.length > bestLen) {
      bestId = f.id;
      bestLen = name.length;
    }
  }
  return bestId;
}
