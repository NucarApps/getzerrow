// Pure merge of ranked search hits (decrypted server-side by the search
// RPCs) with their list-view metadata rows. Used by the searchInbox server
// fn so search is one client round-trip instead of RPC + a follow-up
// metadata fetch from the browser.

type SearchHit = {
  id: string;
  subject: string | null;
  snippet: string | null;
  from_name: string | null;
};

export function mergeSearchRows<H extends SearchHit, M extends { id: string }>(
  hits: H[],
  metaRows: M[],
): Array<
  Omit<M, "subject" | "snippet" | "from_name"> & Pick<H, "subject" | "snippet" | "from_name">
> {
  if (hits.length === 0) return [];
  const metaById = new Map(metaRows.map((m) => [m.id, m]));
  const merged: Array<
    Omit<M, "subject" | "snippet" | "from_name"> & Pick<H, "subject" | "snippet" | "from_name">
  > = [];
  for (const hit of hits) {
    const meta = metaById.get(hit.id);
    // A hit with no metadata row was deleted between the RPC and the select.
    if (!meta) continue;
    merged.push({
      ...meta,
      subject: hit.subject,
      snippet: hit.snippet,
      from_name: hit.from_name,
    });
  }
  return merged;
}
