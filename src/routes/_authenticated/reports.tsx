import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getInboxReport, type InboxReport } from "@/lib/reports.functions";
import { BarChart3, Mail, Inbox, Clock, Calendar, Paperclip, TrendingUp } from "lucide-react";

export const Route = createFileRoute("/_authenticated/reports")({
  head: () => ({
    meta: [
      { title: "Inbox Report — Zerrow" },
      { name: "description", content: "Stats about your inbox: top domains, busiest hours, daily volume." },
    ],
  }),
  component: ReportsPage,
});

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function fmtHour(h: number) {
  const ampm = h < 12 ? "AM" : "PM";
  const hh = ((h + 11) % 12) + 1;
  return `${hh} ${ampm}`;
}

function ReportsPage() {
  const fn = useServerFn(getInboxReport);
  const q = useQuery({ queryKey: ["inbox-report"], queryFn: () => fn() });

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-6 py-8">
        <header className="mb-8 flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-md bg-primary/10 text-primary">
            <BarChart3 className="h-5 w-5" />
          </div>
          <div>
            <h1 className="font-display text-2xl text-foreground">Inbox Report</h1>
            <p className="text-xs text-muted-foreground">Last 90 days</p>
          </div>
        </header>

        {q.isLoading && <Skeleton />}
        {q.error && <p className="text-sm text-destructive">Couldn't load report.</p>}
        {q.data && q.data.sampleSize === 0 && (
          <p className="text-sm text-muted-foreground">No emails in the last 90 days yet.</p>
        )}
        {q.data && q.data.sampleSize > 0 && <Report data={q.data} />}
      </div>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="h-24 animate-pulse rounded-lg border border-border bg-card/40" />
      ))}
    </div>
  );
}

function Report({ data }: { data: InboxReport }) {
  const unreadPct = data.unread + data.read > 0 ? Math.round((data.unread / (data.unread + data.read)) * 100) : 0;
  const attachPct = data.sampleSize > 0 ? Math.round((data.withAttachments / data.sampleSize) * 100) : 0;

  return (
    <div className="space-y-8">
      {/* Stat cards */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <Stat icon={<Mail className="h-4 w-4" />} label="Last 7 days" value={data.totals.d7.toLocaleString()} />
        <Stat icon={<TrendingUp className="h-4 w-4" />} label="Avg / day (30d)" value={data.avgPerDay30.toString()} />
        <Stat icon={<Inbox className="h-4 w-4" />} label="Last 30 days" value={data.totals.d30.toLocaleString()} />
        <Stat
          icon={<Calendar className="h-4 w-4" />}
          label="Busiest day"
          value={data.busiestDow ? DOW[data.busiestDow.dow] : "—"}
          hint={data.busiestDow ? `${data.busiestDow.count} emails` : undefined}
        />
        <Stat
          icon={<Clock className="h-4 w-4" />}
          label="Busiest hour"
          value={data.busiestHour ? fmtHour(data.busiestHour.hour) : "—"}
          hint={data.busiestHour ? `${data.busiestHour.count} emails` : undefined}
        />
        <Stat icon={<Paperclip className="h-4 w-4" />} label="With attachments" value={`${attachPct}%`} hint={`${data.withAttachments.toLocaleString()} emails`} />
      </div>

      {/* Daily volume sparkline */}
      <Card title="Daily volume — last 30 days" subtitle={`${unreadPct}% currently unread`}>
        <Sparkline daily={data.daily} />
      </Card>

      {/* Top domains + senders */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Top sender domains">
          <RankedList
            items={data.topDomains.map((d) => ({ label: d.domain, count: d.count }))}
            total={data.topDomains.reduce((s, d) => s + d.count, 0)}
          />
        </Card>
        <Card title="Top senders">
          <RankedList
            items={data.topSenders.map((d) => ({ label: d.sender, count: d.count }))}
            total={data.topSenders.reduce((s, d) => s + d.count, 0)}
          />
        </Card>
      </div>

      {/* Hour of day histogram */}
      <Card title="When email arrives (hour of day, UTC)">
        <HourBars hours={data.hourHistogram} />
      </Card>

      {/* Folder breakdown */}
      {data.folderBreakdown.length > 0 && (
        <Card title="By folder">
          <div className="space-y-2">
            {data.folderBreakdown.slice(0, 12).map((f) => {
              const max = data.folderBreakdown[0]?.count ?? 1;
              const pct = Math.max(2, Math.round((f.count / max) * 100));
              return (
                <div key={f.folder_id ?? "none"} className="flex items-center gap-3 text-sm">
                  <div className="w-32 truncate text-foreground">{f.name}</div>
                  <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-muted/30">
                    <div
                      className="absolute inset-y-0 left-0 rounded-full"
                      style={{ width: `${pct}%`, background: f.color }}
                    />
                  </div>
                  <div className="w-14 text-right tabular-nums text-muted-foreground">{f.count.toLocaleString()}</div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {data.truncated && (
        <p className="text-[11px] text-muted-foreground">
          Showing the most recent {data.sampleSize.toLocaleString()} emails from the last 90 days.
        </p>
      )}
    </div>
  );
}

function Stat({ icon, label, value, hint }: { icon: React.ReactNode; label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card/40 p-4">
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-widest text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="mt-2 font-display text-2xl text-foreground">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card/40 p-5">
      <div className="mb-4 flex items-baseline justify-between">
        <h2 className="text-sm font-medium text-foreground">{title}</h2>
        {subtitle && <span className="text-[11px] text-muted-foreground">{subtitle}</span>}
      </div>
      {children}
    </div>
  );
}

function RankedList({ items, total }: { items: Array<{ label: string; count: number }>; total: number }) {
  if (items.length === 0) return <p className="text-xs text-muted-foreground">No data.</p>;
  const max = items[0]?.count ?? 1;
  return (
    <div className="space-y-2">
      {items.map((it) => {
        const pct = Math.max(2, Math.round((it.count / max) * 100));
        const share = total > 0 ? Math.round((it.count / total) * 100) : 0;
        return (
          <div key={it.label} className="flex items-center gap-3 text-sm">
            <div className="w-48 truncate text-foreground" title={it.label}>{it.label}</div>
            <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-muted/30">
              <div className="absolute inset-y-0 left-0 rounded-full bg-primary/70" style={{ width: `${pct}%` }} />
            </div>
            <div className="w-20 text-right tabular-nums text-muted-foreground">
              {it.count.toLocaleString()} <span className="text-muted-foreground/60">· {share}%</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Sparkline({ daily }: { daily: Array<{ date: string; count: number }> }) {
  const w = 800, h = 120, pad = 8;
  const max = Math.max(1, ...daily.map((d) => d.count));
  const step = (w - pad * 2) / Math.max(1, daily.length - 1);
  const pts = daily.map((d, i) => {
    const x = pad + i * step;
    const y = h - pad - (d.count / max) * (h - pad * 2);
    return [x, y] as const;
  });
  const path = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${path} L${(pad + (daily.length - 1) * step).toFixed(1)},${h - pad} L${pad},${h - pad} Z`;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-32 w-full" preserveAspectRatio="none">
      <path d={area} fill="hsl(var(--primary) / 0.15)" />
      <path d={path} fill="none" stroke="hsl(var(--primary))" strokeWidth={1.5} />
      {pts.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={1.5} fill="hsl(var(--primary))" />
      ))}
    </svg>
  );
}

function HourBars({ hours }: { hours: number[] }) {
  const max = Math.max(1, ...hours);
  return (
    <div className="flex h-32 items-end gap-1">
      {hours.map((c, i) => {
        const pct = Math.max(2, Math.round((c / max) * 100));
        return (
          <div key={i} className="flex flex-1 flex-col items-center gap-1">
            <div className="w-full flex-1 flex items-end">
              <div className="w-full rounded-sm bg-primary/60" style={{ height: `${pct}%` }} title={`${fmtHour(i)} — ${c}`} />
            </div>
            <div className="text-[9px] tabular-nums text-muted-foreground">{i % 3 === 0 ? i : ""}</div>
          </div>
        );
      })}
    </div>
  );
}
