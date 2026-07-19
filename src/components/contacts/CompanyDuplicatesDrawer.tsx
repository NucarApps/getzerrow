import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Loader2, Sparkles, Merge } from "lucide-react";
import { toast } from "sonner";
import { findDuplicateCompanies, mergeCluster } from "@/lib/companies/companies.functions";

type Props = {
  open: boolean;
  onOpenChange: (v: boolean) => void;
};

type Cluster = {
  canonicalId: string;
  canonicalName: string;
  rationale: string;
  members: {
    id: string;
    name: string;
    member_count: number;
    domains: string[];
    include: boolean;
  }[];
};

export function CompanyDuplicatesDrawer({ open, onOpenChange }: Props) {
  const findFn = useServerFn(findDuplicateCompanies);
  const mergeFn = useServerFn(mergeCluster);
  const qc = useQueryClient();
  const [useAi, setUseAi] = useState(false);
  const [overrides, setOverrides] = useState<
    Record<string, { canonicalId?: string; includes?: Record<string, boolean> }>
  >({});

  const q = useQuery({
    queryKey: ["companies", "duplicates", useAi],
    queryFn: () => findFn({ data: { useAi } }),
    enabled: open,
    staleTime: 30_000,
  });

  const mergeMut = useMutation({
    mutationFn: (vars: { canonicalId: string; foldIds: string[] }) => mergeFn({ data: vars }),
    onSuccess: (r) => {
      toast.success(`Merged ${r.merged} companies · reassigned ${r.movedContacts} contacts`);
      qc.invalidateQueries({ queryKey: ["companies"] });
      qc.invalidateQueries({ queryKey: ["contact-groups"] });
      q.refetch();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Merge failed"),
  });

  const clusters = (q.data?.clusters ?? []) as Cluster[];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto p-6 sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>Find duplicate companies</SheetTitle>
        </SheetHeader>
        <div className="mt-4 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Checkbox id="useAi" checked={useAi} onCheckedChange={(v) => setUseAi(Boolean(v))} />
            <Label htmlFor="useAi" className="cursor-pointer">
              <Sparkles className="mr-1 inline h-3.5 w-3.5" />
              Let AI decide which entries are true duplicates
            </Label>
          </div>
          <Button size="sm" variant="outline" onClick={() => q.refetch()} disabled={q.isFetching}>
            {q.isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : "Rescan"}
          </Button>
        </div>

        {q.isLoading && (
          <div className="mt-8 flex justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {!q.isLoading && clusters.length === 0 && (
          <div className="mt-8 rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            No duplicate clusters detected. Companies look clean.
          </div>
        )}

        <div className="mt-4 space-y-4">
          {clusters.map((cluster) => {
            const ov = overrides[cluster.canonicalId] ?? {};
            const canonicalId = ov.canonicalId ?? cluster.canonicalId;
            const includes = cluster.members.reduce<Record<string, boolean>>((acc, m) => {
              acc[m.id] = ov.includes?.[m.id] ?? m.include;
              return acc;
            }, {});
            const foldIds = cluster.members
              .filter((m) => m.id !== canonicalId && includes[m.id])
              .map((m) => m.id);
            return (
              <div key={cluster.canonicalId} className="rounded-lg border p-4">
                <p className="mb-3 text-xs text-muted-foreground">{cluster.rationale}</p>
                <RadioGroup
                  value={canonicalId}
                  onValueChange={(v) =>
                    setOverrides((prev) => ({
                      ...prev,
                      [cluster.canonicalId]: { ...prev[cluster.canonicalId], canonicalId: v },
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
                        <RadioGroupItem value={m.id} id={`canon-${m.id}`} />
                        <Checkbox
                          disabled={isCanon}
                          checked={isCanon || includes[m.id]}
                          onCheckedChange={(v) =>
                            setOverrides((prev) => ({
                              ...prev,
                              [cluster.canonicalId]: {
                                ...prev[cluster.canonicalId],
                                includes: {
                                  ...prev[cluster.canonicalId]?.includes,
                                  [m.id]: Boolean(v),
                                },
                              },
                            }))
                          }
                        />
                        <div className="min-w-0 flex-1">
                          <Label
                            htmlFor={`canon-${m.id}`}
                            className="cursor-pointer truncate font-medium"
                          >
                            {m.name}
                            {isCanon && (
                              <span className="ml-2 text-xs font-normal text-primary">
                                canonical
                              </span>
                            )}
                          </Label>
                          <div className="truncate text-xs text-muted-foreground">
                            {m.member_count} contact{m.member_count === 1 ? "" : "s"}
                            {m.domains.length > 0 ? ` · ${m.domains.slice(0, 3).join(", ")}` : ""}
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
                      : `Will merge ${foldIds.length} into "${cluster.members.find((m) => m.id === canonicalId)?.name ?? ""}"`}
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
