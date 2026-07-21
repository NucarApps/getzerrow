import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Loader2, Sparkles, Merge, Wand2 } from "lucide-react";
import { toast } from "sonner";
import {
  findDuplicateLabels,
  mergeLabelCluster,
  consolidateLabelDuplicates,
} from "@/lib/contacts/label-duplicates.functions";

type Props = { open: boolean; onOpenChange: (v: boolean) => void };

type Cluster = {
  canonicalId: string;
  canonicalName: string;
  parentGroupId: string | null;
  rationale: string;
  members: {
    id: string;
    name: string;
    member_count: number;
    is_auto: boolean;
    include: boolean;
  }[];
};

export function LabelDuplicatesDrawer({ open, onOpenChange }: Props) {
  const findFn = useServerFn(findDuplicateLabels);
  const mergeFn = useServerFn(mergeLabelCluster);
  const bulkFn = useServerFn(consolidateLabelDuplicates);
  const qc = useQueryClient();
  // AI near-match pass on by default — it's a single bounded model call,
  // and this drawer is launched from the "AI tools" menu; running it with
  // AI off made the tool look broken.
  const [useAi, setUseAi] = useState(true);
  const [overrides, setOverrides] = useState<
    Record<string, { canonicalId?: string; includes?: Record<string, boolean> }>
  >({});

  const q = useQuery({
    queryKey: ["labels", "duplicates", useAi],
    queryFn: () => findFn({ data: { useAi } }),
    enabled: open,
    staleTime: 30_000,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["contact-groups"] });
    qc.invalidateQueries({ queryKey: ["contacts"] });
    q.refetch();
  };

  const mergeMut = useMutation({
    mutationFn: (vars: { canonicalId: string; foldIds: string[] }) => mergeFn({ data: vars }),
    onSuccess: (r) => {
      if (r.failed > 0) {
        toast.error(
          `${r.failed} label${r.failed === 1 ? "" : "s"} could not be merged` +
            (r.errors?.[0] ? `: ${r.errors[0]}` : ""),
        );
      }
      if (r.merged > 0) {
        toast.success(`Merged ${r.merged} labels · moved ${r.movedMembers} members`);
      }
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Merge failed"),
  });

  const bulkMut = useMutation({
    mutationFn: () => bulkFn(),
    onSuccess: (r) => {
      if (r.failedLabels > 0) {
        toast.error(
          `${r.failedLabels} label${r.failedLabels === 1 ? "" : "s"} could not be merged` +
            (r.errors?.[0] ? `: ${r.errors[0]}` : ""),
        );
      }
      if (r.mergedLabels > 0 || r.failedLabels === 0) {
        toast.success(
          `Auto-merged ${r.mergedLabels} label${r.mergedLabels === 1 ? "" : "s"} across ${r.mergedClusters} cluster${r.mergedClusters === 1 ? "" : "s"}`,
        );
      }
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Bulk merge failed"),
  });

  const clusters = (q.data?.clusters ?? []) as Cluster[];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto p-6 sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>Find duplicate labels</SheetTitle>
        </SheetHeader>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Checkbox
              id="labels-useAi"
              checked={useAi}
              onCheckedChange={(v) => setUseAi(Boolean(v))}
            />
            <Label htmlFor="labels-useAi" className="cursor-pointer">
              <Sparkles className="mr-1 inline h-3.5 w-3.5" />
              Also let AI find near-matches (VW ↔ Volkswagen)
            </Label>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => bulkMut.mutate()}
              disabled={bulkMut.isPending || clusters.length === 0}
              title="Auto-merge every exact-name duplicate into its default canonical"
            >
              {bulkMut.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  <Wand2 className="mr-1 h-3.5 w-3.5" /> Auto-merge exact
                </>
              )}
            </Button>
            <Button size="sm" variant="outline" onClick={() => q.refetch()} disabled={q.isFetching}>
              {q.isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : "Rescan"}
            </Button>
          </div>
        </div>

        {q.isLoading && (
          <div className="mt-8 flex justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {!q.isLoading && q.isError && (
          <div className="mt-8 rounded-lg border border-destructive/30 bg-destructive/5 p-8 text-center text-sm text-destructive">
            Couldn&apos;t scan for duplicate labels
            {q.error instanceof Error ? `: ${q.error.message}` : ""}. Tap Rescan to try again.
          </div>
        )}

        {!q.isLoading && !q.isError && clusters.length === 0 && (
          <div className="mt-8 rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            No duplicate labels detected.
          </div>
        )}

        <div className="mt-4 space-y-4">
          {clusters.map((cluster, idx) => {
            const clusterKey = `${cluster.canonicalId}-${idx}`;
            const ov = overrides[clusterKey] ?? {};
            const canonicalId = ov.canonicalId ?? cluster.canonicalId;
            const includes = cluster.members.reduce<Record<string, boolean>>((acc, m) => {
              acc[m.id] = ov.includes?.[m.id] ?? m.include;
              return acc;
            }, {});
            const foldIds = cluster.members
              .filter((m) => m.id !== canonicalId && includes[m.id])
              .map((m) => m.id);
            return (
              <div key={clusterKey} className="rounded-lg border p-4">
                <p className="mb-3 text-xs text-muted-foreground">{cluster.rationale}</p>
                <RadioGroup
                  value={canonicalId}
                  onValueChange={(v) =>
                    setOverrides((prev) => ({
                      ...prev,
                      [clusterKey]: { ...prev[clusterKey], canonicalId: v },
                    }))
                  }
                  className="space-y-2"
                >
                  {cluster.members.map((m) => {
                    const isCanon = m.id === canonicalId;
                    return (
                      <div
                        key={m.id}
                        className="flex items-center gap-3 rounded-md border border-transparent px-2 py-1.5 hover:border-border"
                      >
                        <RadioGroupItem value={m.id} id={`lbl-${clusterKey}-${m.id}`} />
                        <Checkbox
                          disabled={isCanon}
                          checked={isCanon || includes[m.id]}
                          onCheckedChange={(v) =>
                            setOverrides((prev) => ({
                              ...prev,
                              [clusterKey]: {
                                ...prev[clusterKey],
                                includes: {
                                  ...prev[clusterKey]?.includes,
                                  [m.id]: Boolean(v),
                                },
                              },
                            }))
                          }
                        />
                        <div className="min-w-0 flex-1">
                          <Label
                            htmlFor={`lbl-${clusterKey}-${m.id}`}
                            className="cursor-pointer truncate font-medium"
                          >
                            {m.name}
                            {isCanon && (
                              <span className="ml-2 text-xs font-normal text-primary">
                                canonical
                              </span>
                            )}
                            {m.is_auto && (
                              <span className="ml-2 text-xs font-normal text-muted-foreground">
                                auto
                              </span>
                            )}
                          </Label>
                          <div className="truncate text-xs text-muted-foreground">
                            {m.member_count} contact{m.member_count === 1 ? "" : "s"}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </RadioGroup>
                <div className="mt-3 flex items-center justify-between">
                  <p className="text-xs text-muted-foreground">
                    {foldIds.length === 0
                      ? "Select at least one to fold"
                      : `Merge ${foldIds.length} into "${cluster.members.find((m) => m.id === canonicalId)?.name ?? ""}"`}
                  </p>
                  <Button
                    size="sm"
                    disabled={foldIds.length === 0 || mergeMut.isPending}
                    onClick={() => mergeMut.mutate({ canonicalId, foldIds })}
                  >
                    <Merge className="mr-1 h-3.5 w-3.5" />
                    Merge cluster
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </SheetContent>
    </Sheet>
  );
}
