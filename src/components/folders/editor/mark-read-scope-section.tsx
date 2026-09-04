import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import {
  addFolderMarkReadRule,
  listFolderMarkReadRules,
  removeFolderMarkReadRule,
} from "@/lib/gmail/mark-read-rules.functions";

export type MarkReadMode = "all" | "except" | "only";

type Props = {
  folderId: string;
  mode: MarkReadMode;
  onModeChange: (mode: MarkReadMode) => void;
};

const MODE_HELP: Record<MarkReadMode, string> = {
  all: "Every email filed into this folder is marked read.",
  except: "Everything is marked read except mail from the senders and domains below.",
  only: "Only mail from the senders and domains below is marked read.",
};

/** Per-folder scope for auto mark-read: all mail, all except a sender/domain
 * list, or only that list. Entries accept a full address or a bare domain. */
export function MarkReadScopeSection({ folderId, mode, onModeChange }: Props) {
  const qc = useQueryClient();
  const [value, setValue] = useState("");
  const listRules = useServerFn(listFolderMarkReadRules);
  const addRule = useServerFn(addFolderMarkReadRule);
  const removeRule = useServerFn(removeFolderMarkReadRule);

  const rulesQ = useQuery({
    queryKey: ["folder-mark-read-rules", folderId],
    queryFn: () => listRules({ data: { folder_id: folderId } }),
  });

  const addM = useMutation({
    mutationFn: (entry: string) => addRule({ data: { folder_id: folderId, value: entry } }),
    onSuccess: (res) => {
      qc.setQueryData(["folder-mark-read-rules", folderId], res);
      setValue("");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const removeM = useMutation({
    mutationFn: (id: string) => removeRule({ data: { folder_id: folderId, id } }),
    onSuccess: (res) => qc.setQueryData(["folder-mark-read-rules", folderId], res),
    onError: (e: Error) => toast.error(e.message),
  });

  const rules = rulesQ.data?.rules ?? [];

  return (
    <div className="mt-3 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">Mark read for</span>
        <Select value={mode} onValueChange={(v) => onModeChange(v as MarkReadMode)}>
          <SelectTrigger aria-label="Mark read for" className="h-8 w-56 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Everything</SelectItem>
            <SelectItem value="except">Everything except…</SelectItem>
            <SelectItem value="only">Only these senders…</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{MODE_HELP[mode]}</p>

      {mode !== "all" && (
        <div className="mt-3 space-y-2">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const entry = value.trim();
              if (entry) addM.mutate(entry);
            }}
          >
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="name@company.com or company.com"
              className="h-8 text-sm"
            />
            <Button type="submit" size="sm" disabled={addM.isPending || !value.trim()}>
              Add
            </Button>
          </form>

          {rulesQ.isLoading ? (
            <Spinner className="h-4 w-4" />
          ) : rules.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No senders or domains yet.{" "}
              {mode === "only"
                ? "Nothing is marked read until you add one."
                : "All mail in this folder is marked read until you add one."}
            </p>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {rules.map((r) => (
                <li
                  key={r.id}
                  className="flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-xs"
                >
                  <span className="text-muted-foreground">
                    {r.match_type === "domain" ? "@" : ""}
                  </span>
                  {r.value}
                  <button
                    type="button"
                    aria-label={`Remove ${r.value}`}
                    className="text-muted-foreground transition-colors hover:text-foreground"
                    onClick={() => removeM.mutate(r.id)}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
