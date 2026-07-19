import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { GroupRulesSection } from "@/components/contacts/GroupRulesSection";
import {
  createContactGroup,
  updateContactGroup,
  deleteContactGroup,
  linkContactGroupToFolder,
} from "@/lib/contact-groups.functions";
import { listFoldersForPicker } from "@/lib/contacts.functions";
import {
  setAutoCompanySubgroups,
  reconcileAutoCompanySubgroups,
  pruneAutoCompanySubgroups,
} from "@/lib/contacts/auto-company-subgroups.functions";
import { buildGroupTree, eligibleParents } from "@/lib/contacts/group-tree";
import { GROUP_COLORS } from "@/lib/contacts/group-colors";

export type GroupRow = {
  id: string;
  name: string;
  color: string;
  count: number;
  folder_id?: string | null;
  parent_group_id?: string | null;
  auto_company_subgroups?: boolean;
  auto_generated_from_group_id?: string | null;
  linked_folder?: { name: string; color: string | null } | null;
  /** Companies placed in this label via company_id rules. */
  companies?: Array<{ id: string; name: string }>;
};

export type GroupEditorState =
  null | { mode: "create"; parentId?: string | null } | { mode: "edit"; group: GroupRow };

// Radix Select can't represent an empty-string item value.
const NONE = "__none__";

export function GroupEditorDialog({
  state,
  allGroups,
  onClose,
  onChanged,
}: {
  state: GroupEditorState;
  allGroups: GroupRow[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const create = useServerFn(createContactGroup);
  const update = useServerFn(updateContactGroup);
  const del = useServerFn(deleteContactGroup);
  const linkFolder = useServerFn(linkContactGroupToFolder);
  const listFolders = useServerFn(listFoldersForPicker);
  const setAutoFn = useServerFn(setAutoCompanySubgroups);
  const rescanAutoFn = useServerFn(reconcileAutoCompanySubgroups);
  const pruneAutoFn = useServerFn(pruneAutoCompanySubgroups);

  const foldersQ = useQuery({
    queryKey: ["folders-picker"],
    queryFn: () => listFolders(),
    enabled: !!state,
    staleTime: 60_000,
  });

  const [name, setName] = useState("");
  const [color, setColor] = useState(GROUP_COLORS[0]);
  const [folderId, setFolderId] = useState<string>("");
  const [parentId, setParentId] = useState<string>("");
  const [autoSubgroups, setAutoSubgroups] = useState(false);
  const [autoBusy, setAutoBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmPrune, setConfirmPrune] = useState(false);

  useEffect(() => {
    if (!state) return;
    if (state.mode === "edit") {
      setName(state.group.name);
      setColor(state.group.color);
      setFolderId(state.group.folder_id ?? "");
      setParentId(state.group.parent_group_id ?? "");
      setAutoSubgroups(!!state.group.auto_company_subgroups);
    } else {
      setName("");
      setColor(GROUP_COLORS[0]);
      setFolderId("");
      setParentId(state.parentId ?? "");
      setAutoSubgroups(false);
    }
    setConfirmDelete(false);
    setConfirmPrune(false);
  }, [state]);

  if (!state) return null;
  const s = state;
  const editing = s.mode === "edit";
  const editGroup = s.mode === "edit" ? s.group : null;

  // Only offer parents the server would accept (no self/descendants, no
  // over-deep nesting), rendered with tree indentation.
  const eligible = new Set(eligibleParents(allGroups, editGroup?.id ?? null).map((g) => g.id));
  const parentOptions = buildGroupTree(allGroups).filter(({ group }) => eligible.has(group.id));

  async function save() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      let gid: string | null = editGroup?.id ?? null;
      const nextParentId = parentId || null;
      if (editGroup) {
        await update({
          data: {
            id: editGroup.id,
            name: name.trim(),
            color,
            parent_group_id: nextParentId,
          },
        });
      } else {
        const created = await create({
          data: { name: name.trim(), color, parent_group_id: nextParentId },
        });
        gid = (created as { group?: { id: string } })?.group?.id ?? null;
      }
      // Sync folder link (create/remove the sender_in_group filter row).
      if (gid) {
        const nextFolderId = folderId || null;
        const currentFolderId = editGroup?.folder_id ?? null;
        if (nextFolderId !== currentFolderId) {
          await linkFolder({ data: { groupId: gid, folderId: nextFolderId } });
        }
      }
      toast.success(editGroup ? "Group updated" : "Group created");
      onChanged();
      onClose();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!editGroup) return;
    setSaving(true);
    try {
      await del({ data: { id: editGroup.id } });
      toast.success("Group deleted");
      onChanged();
      onClose();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <ResponsiveDialog
        open
        onOpenChange={(v) => {
          if (!v) onClose();
        }}
      >
        <ResponsiveDialogContent className="sm:max-w-sm">
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>{editing ? "Edit group" : "New group"}</ResponsiveDialogTitle>
          </ResponsiveDialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs text-muted-foreground">Name</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Work, Personal, Investors…"
                autoFocus
              />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Color</Label>
              <div className="mt-1 flex flex-wrap gap-2">
                {GROUP_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setColor(c)}
                    className={`h-7 w-7 rounded-full ring-2 ring-offset-2 ring-offset-background transition ${color === c ? "ring-foreground" : "ring-transparent"}`}
                    style={{ background: c }}
                    aria-label={c}
                  />
                ))}
              </div>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Parent group</Label>
              <Select
                value={parentId || NONE}
                onValueChange={(v) => setParentId(v === NONE ? "" : v)}
              >
                <SelectTrigger className="mt-1 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>None — top level</SelectItem>
                  {parentOptions.map(({ group, depth }) => (
                    <SelectItem key={group.id} value={group.id}>
                      {`${"  ".repeat(depth)}${group.name}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Nest this group under another to build a subgroup tree.
              </p>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Linked folder</Label>
              <Select
                value={folderId || NONE}
                onValueChange={(v) => setFolderId(v === NONE ? "" : v)}
              >
                <SelectTrigger className="mt-1 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>None — group only</SelectItem>
                  {(foldersQ.data?.folders ?? []).map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="mt-1 text-[11px] text-muted-foreground">
                When linked, senders in this group are auto-filed into the folder.
              </p>
            </div>
            {editing && editGroup && (
              <div className="rounded-md border border-border/60 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Label className="text-sm">Auto-create company subgroups</Label>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      Adds one subgroup per company found in this group's members. Contacts stay in
                      this group too — the subgroups just slice them by company.
                    </p>
                  </div>
                  <Switch
                    checked={autoSubgroups}
                    disabled={autoBusy}
                    onCheckedChange={async (v) => {
                      setAutoBusy(true);
                      try {
                        await setAutoFn({ data: { groupId: editGroup.id, enabled: v } });
                        setAutoSubgroups(v);
                        onChanged();
                        toast.success(v ? "Auto subgroups enabled" : "Auto subgroups paused");
                      } catch (e: unknown) {
                        toast.error(e instanceof Error ? e.message : "Failed");
                      } finally {
                        setAutoBusy(false);
                      }
                    }}
                  />
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={autoBusy || !autoSubgroups}
                    onClick={async () => {
                      setAutoBusy(true);
                      try {
                        const r = (await rescanAutoFn({
                          data: { groupId: editGroup.id },
                        })) as { stats?: { created: number; removed: number } };
                        onChanged();
                        const c = r.stats?.created ?? 0;
                        const rm = r.stats?.removed ?? 0;
                        toast.success(`Re-scanned: +${c} / -${rm} subgroups`);
                      } catch (e: unknown) {
                        toast.error(e instanceof Error ? e.message : "Failed");
                      } finally {
                        setAutoBusy(false);
                      }
                    }}
                  >
                    Re-scan now
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive"
                    disabled={autoBusy}
                    onClick={() => setConfirmPrune(true)}
                  >
                    Remove auto subgroups
                  </Button>
                </div>
              </div>
            )}
            {editing && editGroup && <GroupRulesSection groupId={editGroup.id} />}
          </div>
          <ResponsiveDialogFooter className="gap-2 sm:gap-0">
            {editing && (
              <Button
                variant="ghost"
                className="text-destructive sm:mr-auto"
                onClick={() => setConfirmDelete(true)}
                disabled={saving}
              >
                <Trash2 className="mr-1.5 h-4 w-4" /> Delete
              </Button>
            )}
            <Button variant="outline" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving || !name.trim()}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </ResponsiveDialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{editGroup?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Contacts won't be deleted — they just lose this label. Subgroups move to the top
              level.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={remove}
            >
              Delete group
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmPrune} onOpenChange={setConfirmPrune}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove all auto-created subgroups?</AlertDialogTitle>
            <AlertDialogDescription>
              Every company subgroup generated under “{editGroup?.name}” will be removed. Contacts
              stay in “{editGroup?.name}”.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={async () => {
                if (!editGroup) return;
                setAutoBusy(true);
                try {
                  const r = (await pruneAutoFn({
                    data: { groupId: editGroup.id },
                  })) as { removed: number };
                  onChanged();
                  toast.success(`Removed ${r.removed} auto subgroup${r.removed === 1 ? "" : "s"}`);
                } catch (e: unknown) {
                  toast.error(e instanceof Error ? e.message : "Failed");
                } finally {
                  setAutoBusy(false);
                }
              }}
            >
              Remove subgroups
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
