import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Activity, Bot, Filter as FilterIcon, Hand, RefreshCw } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { getFolderHealth, relearnFolderNow } from "@/lib/gmail.functions";

type Props = { folderId: string };

function Stat({
  icon,
  label,
  value,
  tone = "default",
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone?: "default" | "warn";
}) {
  return (
    <div className="rounded-md border border-border bg-muted/20 p-2.5">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
        {icon}
        {label}
      </div>
      <div
        className={`mt-1 text-lg font-semibold ${tone === "warn" ? "text-amber-600 dark:text-amber-400" : "text-foreground"}`}
      >
        {value}
      </div>
    </div>
  );
}

export function FolderHealthCard({ folderId }: Props) {
  const qc = useQueryClient();
  const fetchHealth = useServerFn(getFolderHealth);
  const relearn = useServerFn(relearnFolderNow);
  const [relearning, setRelearning] = useState(false);

  const healthQ = useQuery({
    queryKey: ["folder-health", folderId],
    queryFn: () => fetchHealth({ data: { folder_id: folderId } }),
  });

  const h = healthQ.data;

  const handleRelearn = async () => {
    setRelearning(true);
    try {
      await relearn({ data: { folder_id: folderId } });
      toast.success("Relearned from your examples.");
      qc.invalidateQueries({ queryKey: ["folder-health", folderId] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't relearn this folder.");
    } finally {
      setRelearning(false);
    }
  };

  return (
    <div className="mb-5 rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-foreground">
          <Activity className="h-3.5 w-3.5" /> Health
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs"
          onClick={handleRelearn}
          disabled={relearning}
        >
          <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${relearning ? "animate-spin" : ""}`} />
          Relearn now
        </Button>
      </div>

      {healthQ.isLoading ? (
        <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner className="h-3.5 w-3.5" /> Loading…
        </div>
      ) : !h ? (
        <p className="mt-3 text-xs text-muted-foreground">Couldn't load health right now.</p>
      ) : h.total === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Nothing filed here yet. Stats appear once mail lands in this folder.
        </p>
      ) : (
        <>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat
              icon={<FilterIcon className="h-3 w-3" />}
              label="By rules"
              value={String(h.byRules)}
            />
            <Stat icon={<Bot className="h-3 w-3" />} label="By AI" value={String(h.byAi)} />
            <Stat icon={<Hand className="h-3 w-3" />} label="Manual" value={String(h.byManual)} />
            <Stat
              icon={<Activity className="h-3 w-3" />}
              label="Low confidence"
              value={String(h.lowConfidence)}
              tone={h.lowConfidence > 0 ? "warn" : "default"}
            />
          </div>

          <p className="mt-3 text-xs text-muted-foreground">
            {h.total} filed
            {h.sampled < h.total ? ` · stats from the last ${h.sampled}` : ""}
            {h.avgConfidence != null
              ? ` · avg AI confidence ${Math.round(h.avgConfidence * 100)}%`
              : ""}
          </p>

          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{h.learning.examples} learning examples</span>
            <span>
              {h.learning.recentCorrections > 0
                ? `${h.learning.recentCorrections} recent correction${h.learning.recentCorrections === 1 ? "" : "s"}`
                : "no recent corrections"}
            </span>
            <span>
              {h.learning.lastLearnedAt
                ? `learned ${formatDistanceToNow(new Date(h.learning.lastLearnedAt), { addSuffix: true })}`
                : "not learned yet"}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
