import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { X, Plus, Trash2 } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import {
  addCompanyAlias, removeCompanyAlias, clearCompanyAliases,
} from "@/lib/company-aliases.functions";
import { CompanyLogo } from "./CompanyLogo";

type Props = {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  primaryDomain: string | null;
  companyName: string;
  aliases: string[];
};

export function CompanyAliasesDialog({
  open, onOpenChange, primaryDomain, companyName, aliases,
}: Props) {
  const qc = useQueryClient();
  const addFn = useServerFn(addCompanyAlias);
  const removeFn = useServerFn(removeCompanyAlias);
  const clearFn = useServerFn(clearCompanyAliases);

  const [newDomain, setNewDomain] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) setNewDomain("");
  }, [open]);

  if (!primaryDomain) return null;

  function invalidate() {
    qc.invalidateQueries({ queryKey: ["company-aliases"] });
  }

  async function add() {
    const d = newDomain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!d) return;
    setBusy(true);
    try {
      await addFn({ data: { primaryDomain: primaryDomain!, aliasDomain: d } });
      toast.success(`Merged ${d}`);
      setNewDomain("");
      invalidate();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Couldn't add domain";
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  }

  async function remove(alias: string) {
    setBusy(true);
    try {
      await removeFn({ data: { aliasDomain: alias } });
      invalidate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't remove");
    } finally {
      setBusy(false);
    }
  }

  async function clearAll() {
    if (aliases.length === 0) { onOpenChange(false); return; }
    if (!confirm(`Remove all ${aliases.length} merged ${aliases.length === 1 ? "domain" : "domains"}?`)) return;
    setBusy(true);
    try {
      await clearFn({ data: { primaryDomain: primaryDomain! } });
      toast.success("Merge cleared");
      invalidate();
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't clear");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <CompanyLogo domain={primaryDomain} name={companyName} size={28} />
            <span className="truncate">{companyName}</span>
          </DialogTitle>
          <DialogDescription>
            Merge multiple email domains under this company. The logo uses the primary domain.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label className="text-xs uppercase tracking-widest text-muted-foreground">Primary domain</Label>
            <div className="mt-1 inline-flex items-center rounded-md border border-border bg-muted/40 px-2.5 py-1 text-sm">
              {primaryDomain}
            </div>
          </div>

          <div>
            <Label className="text-xs uppercase tracking-widest text-muted-foreground">
              Other domains for this company
            </Label>
            <div className="mt-1 space-y-1">
              {aliases.length === 0 ? (
                <p className="text-xs text-muted-foreground">No merged domains yet.</p>
              ) : (
                aliases.map((a) => (
                  <div key={a} className="flex items-center gap-2 rounded-md border border-border bg-card/40 px-2.5 py-1.5 text-sm">
                    <span className="flex-1 truncate">{a}</span>
                    <button
                      onClick={() => remove(a)}
                      disabled={busy}
                      aria-label={`Remove ${a}`}
                      className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))
              )}
            </div>
            <div className="mt-2 flex gap-2">
              <Input
                value={newDomain}
                onChange={(e) => setNewDomain(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void add(); } }}
                placeholder="acme.io"
                disabled={busy}
              />
              <Button onClick={add} disabled={busy || !newDomain.trim()} size="sm">
                <Plus className="mr-1 h-4 w-4" /> Add
              </Button>
            </div>
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              If that domain is already its own company, it will be merged in.
            </p>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          {aliases.length > 0 && (
            <Button variant="ghost" className="mr-auto text-destructive" onClick={clearAll} disabled={busy}>
              <Trash2 className="mr-1.5 h-4 w-4" /> Delete merge
            </Button>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
