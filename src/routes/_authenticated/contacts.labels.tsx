import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  FolderInput,
  Lock,
  MoreVertical,
  Pencil,
  Plus,
  Sparkles,
  Tags,
  Trash2,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  GroupEditorDialog,
  type GroupEditorState,
  type GroupRow,
} from "@/components/contacts/GroupEditorDialog";
import { LabelDuplicatesDrawer } from "@/components/contacts/LabelDuplicatesDrawer";
import { GroupSuggestionsDrawer } from "@/components/contacts/GroupSuggestionsDrawer";
import {
  listContactGroups,
  updateContactGroup,
  deleteContactGroup,
} from "@/lib/contact-groups.functions";
import { buildDescendantsById, buildGroupTree, eligibleParents } from "@/lib/contacts/group-tree";

export const Route = createFileRoute("/_authenticated/contacts/labels")({
  head: () => ({
    meta: [
      { title: "Labels — Zerrow" },
      { name: "description", content: "Organize your contact labels and subgroups." },
    ],
  }),
  component: LabelsPage,
});

function LabelsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const listGroups = useServerFn(listContactGroups);
  const update = useServerFn(updateContactGroup);
  const del = useServerFn(deleteContactGroup);

  const gq = useQuery({ queryKey: ["contact-groups"], queryFn: () => listGroups() });
  const groups = useMemo(() => (gq.data?.groups ?? []) as GroupRow[], [gq.data]);
  const tree = useMemo(() => buildGroupTree(groups), [groups]);
  const descendants = useMemo(() => buildDescendantsById(groups), [groups]);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [editorState, setEditorState] = useState<GroupEditorState>(null);
  const [moveTarget, setMoveTarget] = useState<GroupRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<GroupRow | null>(null);
  const [dedupeOpen, setDedupeOpen] = useState(false);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const hasChildren = useMemo(() => {
    const s = new Set<string>();
    for (const g of groups) if (g.parent_group_id) s.add(g.parent_group_id);
    return s;
  }, [groups]);

  // Rows hidden by a collapsed ancestor.
  const visibleTree = useMemo(() => {
    if (collapsed.size === 0) return tree;
    const hidden = new Set<string>();
    for (const id of collapsed) {
      for (const d of descendants.get(id) ?? []) {
        if (d !== id) hidden.add(d);
      }
    }
    return tree.filter(({ group }) => !hidden.has(group.id));
  }, [tree, collapsed, descendants]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["contact-groups"] });
    qc.invalidateQueries({ queryKey: ["contacts"] });
  };

  async function moveTo(group: GroupRow, parentId: string | null) {
    setBusy(true);
    try {
      await update({ data: { id: group.id, parent_group_id: parentId } });
      toast.success(parentId ? "Label moved" : "Label moved to top level");
      invalidate();
      setMoveTarget(null);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function removeLabel(group: GroupRow) {
    setBusy(true);
    try {
      await del({ data: { id: group.id } });
      toast.success("Label deleted");
      invalidate();
      setDeleteTarget(null);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  const moveOptions = useMemo(() => {
    if (!moveTarget) return [];
    const eligible = new Set(eligibleParents(groups, moveTarget.id).map((g) => g.id));
    return buildGroupTree(groups).filter(
      ({ group }) => eligible.has(group.id) && !group.auto_generated_from_group_id,
    );
  }, [groups, moveTarget]);

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden">
      <div className="mx-auto max-w-3xl px-4 py-6 sm:py-8">
        <div className="mb-1">
          <Link
            to="/contacts"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Contacts
          </Link>
        </div>
        <header className="mb-6 flex items-center gap-2 sm:gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
            <Tags className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="font-display text-xl text-foreground sm:text-2xl">Labels</h1>
            <p className="text-xs text-muted-foreground">
              {gq.data ? `${groups.length} labels` : "Loading…"}
            </p>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="px-2 sm:px-3">
                <Sparkles className="h-4 w-4 sm:mr-2" />
                <span className="hidden sm:inline">AI tools</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setDedupeOpen(true)}>
                Find duplicate labels
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setSuggestOpen(true)}>
                Suggest groups
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            size="sm"
            onClick={() => setEditorState({ mode: "create" })}
            className="px-2 sm:px-3"
          >
            <Plus className="h-4 w-4 sm:mr-2" />
            <span className="hidden sm:inline">New label</span>
          </Button>
        </header>

        {gq.isLoading ? (
          <div className="grid gap-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-12 animate-pulse rounded-md bg-accent/40" />
            ))}
          </div>
        ) : visibleTree.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
            No labels yet. Create one like “Work” or “Personal”, then nest sub-labels under it.
          </div>
        ) : (
          <ul className="divide-y divide-border/60 rounded-md border border-border">
            {visibleTree.map(({ group: g, depth }) => {
              const isAuto = !!g.auto_generated_from_group_id;
              const isCollapsed = collapsed.has(g.id);
              const canCollapse = hasChildren.has(g.id);
              return (
                <li key={g.id} className="flex items-center gap-2 px-2 py-2 sm:px-3">
                  <div style={{ width: depth * 16 }} className="shrink-0" />
                  {canCollapse ? (
                    <button
                      type="button"
                      onClick={() =>
                        setCollapsed((prev) => {
                          const next = new Set(prev);
                          if (next.has(g.id)) next.delete(g.id);
                          else next.add(g.id);
                          return next;
                        })
                      }
                      className="grid h-6 w-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent/60"
                      aria-label={isCollapsed ? "Expand" : "Collapse"}
                    >
                      {isCollapsed ? (
                        <ChevronRight className="h-4 w-4" />
                      ) : (
                        <ChevronDown className="h-4 w-4" />
                      )}
                    </button>
                  ) : (
                    <div className="h-6 w-6 shrink-0" />
                  )}
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ background: g.color }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm text-foreground">{g.name}</span>
                      {isAuto && (
                        <Lock
                          className="h-3 w-3 shrink-0 text-muted-foreground"
                          aria-label="Managed automatically"
                        />
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                      <span>
                        {g.count} contact{g.count === 1 ? "" : "s"}
                      </span>
                      {g.linked_folder && (
                        <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
                          {g.linked_folder.name}
                        </Badge>
                      )}
                      {g.auto_company_subgroups && (
                        <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
                          Auto subgroups
                        </Badge>
                      )}
                    </div>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9 shrink-0 text-muted-foreground"
                        aria-label={`Actions for ${g.name}`}
                      >
                        <MoreVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onSelect={() => navigate({ to: "/contacts", search: { group: g.id } })}
                      >
                        <Users className="mr-2 h-4 w-4" /> View contacts
                      </DropdownMenuItem>
                      {!isAuto && (
                        <>
                          <DropdownMenuItem
                            onSelect={() => setEditorState({ mode: "edit", group: g })}
                          >
                            <Pencil className="mr-2 h-4 w-4" /> Edit…
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => setEditorState({ mode: "create", parentId: g.id })}
                          >
                            <CornerDownRight className="mr-2 h-4 w-4" /> Add sub-label
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => setMoveTarget(g)}>
                            <FolderInput className="mr-2 h-4 w-4" /> Move to…
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            onSelect={() => setDeleteTarget(g)}
                          >
                            <Trash2 className="mr-2 h-4 w-4" /> Delete
                          </DropdownMenuItem>
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </li>
              );
            })}
          </ul>
        )}

        <p className="mt-4 text-xs text-muted-foreground">
          Labels sync to your iPhone as contact groups. Locked labels are created automatically from
          a parent's companies — manage them from the parent label's settings.
        </p>
      </div>

      <GroupEditorDialog
        state={editorState}
        allGroups={groups}
        onClose={() => setEditorState(null)}
        onChanged={invalidate}
      />

      <ResponsiveDialog open={!!moveTarget} onOpenChange={(v) => !v && setMoveTarget(null)}>
        <ResponsiveDialogContent className="sm:max-w-sm">
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>Move “{moveTarget?.name}”</ResponsiveDialogTitle>
          </ResponsiveDialogHeader>
          <Command className="rounded-md border border-border">
            <CommandInput placeholder="Search labels…" />
            <CommandList className="max-h-64">
              <CommandEmpty>No labels found.</CommandEmpty>
              <CommandGroup>
                <CommandItem
                  disabled={busy}
                  onSelect={() => moveTarget && moveTo(moveTarget, null)}
                >
                  Top level
                </CommandItem>
                {moveOptions.map(({ group, depth }) => (
                  <CommandItem
                    key={group.id}
                    disabled={busy}
                    onSelect={() => moveTarget && moveTo(moveTarget, group.id)}
                  >
                    <span style={{ paddingLeft: depth * 12 }} className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full" style={{ background: group.color }} />
                      {group.name}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </ResponsiveDialogContent>
      </ResponsiveDialog>

      <AlertDialog open={!!deleteTarget} onOpenChange={(v) => !v && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleteTarget?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Contacts won't be deleted — they just lose this label. Sub-labels move to the top
              level.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteTarget && removeLabel(deleteTarget)}
            >
              Delete label
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <LabelDuplicatesDrawer open={dedupeOpen} onOpenChange={setDedupeOpen} />
      <GroupSuggestionsDrawer open={suggestOpen} onOpenChange={setSuggestOpen} />
    </div>
  );
}
