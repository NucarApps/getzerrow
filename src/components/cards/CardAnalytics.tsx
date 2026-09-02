import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Eye, MousePointerClick, Download, Share2 } from "lucide-react";
import { getMyCardAnalytics, type CardAnalyticsSummary } from "@/lib/card-analytics.functions";
import { buildSparkline } from "@/lib/ui/sparkline";
import { cardEventLabel } from "@/lib/ui/card-analytics";

const RANGES = [
  { label: "7 days", value: 7 },
  { label: "30 days", value: 30 },
  { label: "90 days", value: 90 },
];

export function CardAnalytics() {
  const fetchFn = useServerFn(getMyCardAnalytics);
  const [days, setDays] = useState(30);
  const q = useQuery({
    queryKey: ["card-analytics", days],
    queryFn: () => fetchFn({ data: { days } }),
  });

  const data = q.data as CardAnalyticsSummary | undefined;

  return (
    <div className="rounded-lg border border-border bg-card/40 p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-foreground">Card analytics</h2>
        <div className="flex gap-1 rounded-md border border-border p-0.5 text-xs">
          {RANGES.map((r) => (
            <button
              key={r.value}
              onClick={() => setDays(r.value)}
              className={`rounded px-2 py-1 transition ${
                days === r.value
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {q.isLoading && <p className="text-xs text-muted-foreground">Loading…</p>}
      {q.error && <p className="text-xs text-destructive">Couldn't load analytics.</p>}

      {data && (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat icon={<Eye className="h-4 w-4" />} label="Views" value={data.totals.view ?? 0} />
            <Stat
              icon={<MousePointerClick className="h-4 w-4" />}
              label="Link clicks"
              value={data.totals.link_click ?? 0}
            />
            <Stat
              icon={<Download className="h-4 w-4" />}
              label="vCard saves"
              value={data.totals.vcard_download ?? 0}
            />
            <Stat
              icon={<Share2 className="h-4 w-4" />}
              label="Shares"
              value={data.totals.share ?? 0}
            />
          </div>

          <Sparkline daily={data.daily} />

          {data.topLinks.length > 0 && (
            <div className="mt-5">
              <h3 className="mb-2 text-xs font-medium text-muted-foreground">Top links</h3>
              <ul className="space-y-1.5">
                {data.topLinks.map((l, i) => (
                  <li
                    key={i}
                    className="flex items-center justify-between gap-3 rounded-md bg-background/40 px-3 py-1.5 text-xs"
                  >
                    <span className="min-w-0 truncate">
                      <span className="mr-2 inline-block rounded bg-accent px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-foreground">
                        {l.link_kind}
                      </span>
                      <span className="text-foreground/80">{l.link_url ?? "—"}</span>
                    </span>
                    <span className="font-mono text-foreground">{l.count}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {data.recent.length > 0 && (
            <div className="mt-5">
              <h3 className="mb-2 text-xs font-medium text-muted-foreground">Recent activity</h3>
              <ul className="max-h-60 space-y-1 overflow-y-auto">
                {data.recent.map((e) => (
                  <li
                    key={e.id}
                    className="flex items-center justify-between gap-3 text-xs text-muted-foreground"
                  >
                    <span className="truncate">
                      <span className="text-foreground">{cardEventLabel(e.event_type)}</span>
                      {e.link_url && <span className="ml-2 truncate">→ {e.link_url}</span>}
                    </span>
                    <time className="shrink-0 font-mono">
                      {new Date(e.created_at).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </time>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {(data.totals.view ?? 0) === 0 && (data.totals.link_click ?? 0) === 0 && (
            <p className="mt-4 text-center text-xs text-muted-foreground">
              No activity yet — share your card and check back here.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="rounded-md border border-border bg-background/40 px-3 py-2.5">
      <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
        {icon} {label}
      </div>
      <div className="font-display text-xl text-foreground">{value.toLocaleString()}</div>
    </div>
  );
}

function Sparkline({ daily }: { daily: CardAnalyticsSummary["daily"] }) {
  const chart = buildSparkline(daily);
  if (!chart) return null;

  return (
    <div className="mt-4 overflow-hidden rounded-md border border-border bg-background/30 p-2">
      <svg
        viewBox={`0 0 ${chart.width} ${chart.height}`}
        preserveAspectRatio="none"
        className="h-20 w-full"
      >
        {chart.bars.map((bar) => (
          <rect
            key={bar.day}
            x={bar.x}
            y={bar.y}
            width={bar.width}
            height={bar.height}
            className="fill-primary/70"
            rx={1}
          >
            <title>{`${bar.day}: ${bar.total}`}</title>
          </rect>
        ))}
      </svg>
      <div className="flex justify-between px-1 pt-1 text-[10px] text-muted-foreground">
        <span>{chart.firstDay}</span>
        <span>{chart.lastDay}</span>
      </div>
    </div>
  );
}
