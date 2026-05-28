import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

type FolderInfo = { id: string; name: string; color: string };

export type InboxReport = {
  windowDays: number;
  totals: { d7: number; d30: number; d90: number };
  avgPerDay30: number;
  unread: number;
  read: number;
  withAttachments: number;
  busiestDow: { dow: number; count: number } | null;
  busiestHour: { hour: number; count: number } | null;
  dowHistogram: number[]; // length 7, Sun..Sat
  hourHistogram: number[]; // length 24
  daily: Array<{ date: string; count: number }>; // last 30 days asc
  topDomains: Array<{ domain: string; count: number }>;
  topSenders: Array<{ sender: string; count: number }>;
  folderBreakdown: Array<{ folder_id: string | null; name: string; color: string; count: number }>;
  sampleSize: number;
  truncated: boolean;
};

function parseDomain(addr: string | null): string | null {
  if (!addr) return null;
  const m = addr.match(/<([^>]+)>/);
  const email = (m ? m[1] : addr).trim().toLowerCase();
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const dom = email.slice(at + 1).replace(/[>,\s].*$/, "");
  return dom || null;
}

function parseSender(addr: string | null, name: string | null): string {
  if (name && name.trim()) return name.trim();
  if (!addr) return "(unknown)";
  const m = addr.match(/<([^>]+)>/);
  return (m ? m[1] : addr).trim().toLowerCase();
}

export const getInboxReport = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<InboxReport> => {
    const { supabase } = context;
    const ROW_CAP = 20000;
    const PAGE_SIZE = 1000;
    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

    type EmailRow = {
      from_addr: string | null;
      from_name: string | null;
      received_at: string | null;
      folder_id: string | null;
      is_read: boolean;
      has_attachment: boolean;
    };

    const emails: EmailRow[] = [];
    for (let from = 0; from < ROW_CAP; from += PAGE_SIZE) {
      const to = Math.min(from + PAGE_SIZE - 1, ROW_CAP - 1);
      const { data, error } = await supabase
        .from("emails")
        .select("from_addr,received_at,folder_id,is_read,has_attachment")
        .gte("received_at", since)
        .order("received_at", { ascending: false })
        .range(from, to);
      if (error) break;
      const batch = (data ?? []) as unknown as EmailRow[];
      emails.push(...batch);
      if (batch.length < PAGE_SIZE) break;
    }


    const folderIds = Array.from(new Set(emails.map((e) => e.folder_id).filter((x): x is string => !!x)));
    let folders: FolderInfo[] = [];
    if (folderIds.length) {
      const { data: fdata } = await supabase
        .from("folders")
        .select("id,name,color")
        .in("id", folderIds);
      folders = (fdata ?? []) as FolderInfo[];
    }
    const folderMap = new Map(folders.map((f) => [f.id, f]));

    const now = Date.now();
    const d7 = now - 7 * 86400000;
    const d30 = now - 30 * 86400000;

    let total7 = 0, total30 = 0;
    let unread = 0, read = 0, attach = 0;
    const dow = new Array(7).fill(0) as number[];
    const hour = new Array(24).fill(0) as number[];
    const domains = new Map<string, number>();
    const senders = new Map<string, number>();
    const folderCounts = new Map<string | null, number>();
    const dailyMap = new Map<string, number>();

    // Pre-seed last 30 days as keys for sparkline
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now - i * 86400000);
      const key = d.toISOString().slice(0, 10);
      dailyMap.set(key, 0);
    }

    for (const e of emails) {
      if (!e.received_at) continue;
      const t = new Date(e.received_at).getTime();
      if (Number.isNaN(t)) continue;

      if (t >= d7) total7++;
      if (t >= d30) {
        total30++;
        const dkey = new Date(t).toISOString().slice(0, 10);
        if (dailyMap.has(dkey)) dailyMap.set(dkey, (dailyMap.get(dkey) ?? 0) + 1);
      }

      if (e.is_read) read++; else unread++;
      if (e.has_attachment) attach++;

      const dt = new Date(t);
      dow[dt.getUTCDay()]++;
      hour[dt.getUTCHours()]++;

      const dom = parseDomain(e.from_addr);
      if (dom) domains.set(dom, (domains.get(dom) ?? 0) + 1);

      const snd = parseSender(e.from_addr, e.from_name);
      senders.set(snd, (senders.get(snd) ?? 0) + 1);

      folderCounts.set(e.folder_id, (folderCounts.get(e.folder_id) ?? 0) + 1);
    }

    const topDomains = [...domains.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([domain, count]) => ({ domain, count }));

    const topSenders = [...senders.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([sender, count]) => ({ sender, count }));

    const folderBreakdown = [...folderCounts.entries()]
      .map(([fid, count]) => {
        const f = fid ? folderMap.get(fid) : undefined;
        return {
          folder_id: fid,
          name: f?.name ?? "Uncategorized",
          color: f?.color ?? "#71717a",
          count,
        };
      })
      .sort((a, b) => b.count - a.count);

    const busiestDow = dow.reduce<{ dow: number; count: number } | null>(
      (best, count, i) => (best === null || count > best.count ? { dow: i, count } : best),
      null,
    );
    const busiestHour = hour.reduce<{ hour: number; count: number } | null>(
      (best, count, i) => (best === null || count > best.count ? { hour: i, count } : best),
      null,
    );

    return {
      windowDays: 90,
      totals: { d7: total7, d30: total30, d90: emails.length },
      avgPerDay30: Math.round((total30 / 30) * 10) / 10,
      unread,
      read,
      withAttachments: attach,
      busiestDow: busiestDow && busiestDow.count > 0 ? busiestDow : null,
      busiestHour: busiestHour && busiestHour.count > 0 ? busiestHour : null,
      dowHistogram: dow,
      hourHistogram: hour,
      daily: [...dailyMap.entries()].map(([date, count]) => ({ date, count })),
      topDomains,
      topSenders,
      folderBreakdown,
      sampleSize: emails.length,
      truncated: emails.length >= ROW_CAP,
    };
  });
