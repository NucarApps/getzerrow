import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { scanGmailForFolder } from "@/lib/gmail.functions";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { Folder } from "./types";

export function ScanGmailSection({
  folder,
  hasIncludeRules,
}: {
  folder: Folder;
  hasIncludeRules: boolean;
}) {
  const qc = useQueryClient();
  const scanFn = useServerFn(scanGmailForFolder);
  const [months, setMonths] = useState<"1" | "3" | "6" | "12">("6");
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState<string | null>(null);

  async function run() {
    if (!hasIncludeRules) {
      toast.error("Add a domain, sender, or subject rule first.");
      return;
    }
    setBusy(true);
    setLastResult(null);
    try {
      const res = await scanFn({
        data: { folder_id: folder.id, months: Number(months) as 1 | 3 | 6 | 12 },
      });
      if (!res.ok && res.reason === "no_translatable_rules") {
        toast.error(
          "None of this folder's rules can be scanned in Gmail (regex rules are skipped).",
        );
        return;
      }
      if (!res.ok && res.reason === "reauth_required") {
        toast.error("Gmail needs to be reconnected for this account.");
        return;
      }
      const msg =
        res.ingested === 0
          ? `Scanned ${res.found} message${res.found === 1 ? "" : "s"} · no new matches`
          : `Scanned ${res.found} · added ${res.ingested} new`;
      const suffix = res.truncated ? " (capped — run again to continue)" : "";
      setLastResult(msg + suffix);
      toast.success(msg + suffix);
      qc.invalidateQueries({ queryKey: ["emails"] });
      qc.invalidateQueries({ queryKey: ["emails-summary"] });
      qc.invalidateQueries({ queryKey: ["folder-filters", folder.id] });
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      toast.error(`Scan failed: ${m}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-6 rounded-md border border-border p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground">
            Scan Gmail for matches
          </Label>
          <p className="mt-1 text-xs text-muted-foreground">
            Search Gmail for messages matching this folder's rules and pull in anything missing.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Select value={months} onValueChange={(v) => setMonths(v as "1" | "3" | "6" | "12")}>
            <SelectTrigger className="h-8 w-28 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">Last month</SelectItem>
              <SelectItem value="3">Last 3 months</SelectItem>
              <SelectItem value="6">Last 6 months</SelectItem>
              <SelectItem value="12">Last year</SelectItem>
            </SelectContent>
          </Select>
          <Button size="sm" onClick={run} disabled={busy || !hasIncludeRules}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Scan now"}
          </Button>
        </div>
      </div>
      {!hasIncludeRules && (
        <p className="mt-2 text-xs text-muted-foreground">
          Add a domain, sender, or subject rule to enable scanning.
        </p>
      )}
      {lastResult && <p className="mt-2 text-xs text-foreground">{lastResult}</p>}
    </div>
  );
}
