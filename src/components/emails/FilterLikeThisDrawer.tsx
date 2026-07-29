import { useEffect, useMemo, useRef, useState } from "react";
import { emailDomain } from "@/lib/company-domains";
import { parseViaDisplayName } from "@/lib/gmail/origin-sender";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import {
  addFolderRule,
  countMatchingForRule,
  applyFilterRuleToPast,
  addInboxOverride,
  stripFolderLabelPast,
} from "@/lib/gmail.functions";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Checkbox } from "@/components/ui/checkbox";
import { AtSign, Globe, Type, Inbox, Forward, CheckCheck, MailOpen } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";

type Folder = { id: string; name: string; color: string };
type Field = "from" | "domain" | "subject";
type Op = "contains" | "equals" | "starts_with";
type MarkReadDecision = {
  auto_mark_read: boolean;
  mark_read_mode: "all" | "except" | "only";
  listed: boolean;
  would_mark_read: boolean;
};

const INBOX_OVERRIDE = "__inbox__";

export function FilterLikeThisDrawer({
  open,
  onOpenChange,
  accountId,
  fromAddr,
  fromName,
  originAddr,
  isForwarded,
  subject,
  folders,
  currentFolderId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  accountId: string | null;
  fromAddr: string | null;
  /** Display name from the From header, e.g. `"Manheim" via Old User Ken`. */
  fromName?: string | null;
  /** Real sender recovered from forwarding headers, when the mail was
   * auto-forwarded (e.g. by a former colleague's still-active address). */
  originAddr?: string | null;
  isForwarded?: boolean | null;
  subject: string | null;
  folders: Folder[];
  currentFolderId: string | null;
}) {
  const qc = useQueryClient();
  const addRuleFn = useServerFn(addFolderRule);
  const countFn = useServerFn(countMatchingForRule);
  const applyPastFn = useServerFn(applyFilterRuleToPast);
  const addOverrideFn = useServerFn(addInboxOverride);
  const stripLabelFn = useServerFn(stripFolderLabelPast);
  const markReadDecisionFn = useServerFn(getFolderMarkReadDecision);
  const setSenderMarkReadFn = useServerFn(setSenderMarkRead);

  // Same derivation the filter engine and override matcher use — this drawer
  // WRITES rules/overrides, so a divergent value here creates a rule that can
  // never match the sender it was created from.
  // When a message was auto-forwarded, rules built from the visible sender
  // target the forwarder, not the party the user actually cares about. Default
  // to the original sender and let them switch back.
  const forwarded = !!isForwarded && !!originAddr && originAddr !== fromAddr;
  // Relayed mail where no header named the real sender: we know the visible
  // address belongs to the relay, so warn before a rule targets everything
  // that mailbox forwards.
  const via = useMemo(() => parseViaDisplayName(fromName), [fromName]);
  const relayOnly = !forwarded && (!!isForwarded || !!via);
  const [useOrigin, setUseOrigin] = useState(forwarded);
  const senderAddr = useOrigin && originAddr ? originAddr : fromAddr;

  const domain = useMemo(() => emailDomain(senderAddr), [senderAddr]);

  const [field, setField] = useState<Field>("from");
  const [value, setValue] = useState("");
  const [op, setOp] = useState<Op>("starts_with");
  const [folderId, setFolderId] = useState<string | null>(null);
  const [applyToPast, setApplyToPast] = useState(false);
  const [archivePast, setArchivePast] = useState(false);
  const [count, setCount] = useState<number | null>(null);
  const [countLoading, setCountLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  // Folder auto mark-read scope for the sender/domain being filtered.
  const [decision, setDecision] = useState<MarkReadDecision | null>(null);
  const [decisionLoading, setDecisionLoading] = useState(false);
  const [markRead, setMarkRead] = useState<boolean | null>(null);

  // Reset state when reopened or seed changes.
  useEffect(() => {
    if (!open) return;
    setUseOrigin(forwarded);
    const initialField: Field = senderAddr ? "from" : subject ? "subject" : "domain";
    setField(initialField);
    setValue(
      initialField === "from"
        ? (senderAddr ?? "")
        : initialField === "domain"
          ? (domain ?? "")
          : (subject ?? ""),
    );
    setOp(initialField === "subject" ? "starts_with" : "contains");
    setFolderId(null);
    setApplyToPast(false);
    setArchivePast(false);
    setCount(null);
  }, [open, senderAddr, subject, domain, forwarded]);

  // When the user switches field, repopulate the value with the email's value
  // for that field.
  function pickField(f: Field) {
    setField(f);
    setValue(f === "from" ? (senderAddr ?? "") : f === "domain" ? (domain ?? "") : (subject ?? ""));
    setOp(f === "subject" ? "starts_with" : "contains");
  }

  // The rule field actually saved: origin_* variants match the forwarded-from
  // sender and fall back to from_addr for directly delivered mail.
  const ruleField: "from" | "domain" | "subject" | "origin_from" | "origin_domain" =
    useOrigin && field === "from"
      ? "origin_from"
      : useOrigin && field === "domain"
        ? "origin_domain"
        : field;

  // Debounced live count.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!open || !accountId || !value.trim()) {
      setCount(null);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setCountLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const r = await countFn({
          data: { account_id: accountId, field: ruleField, op, value: value.trim() },
        });
        setCount(r.count);
      } catch {
        setCount(null);
      } finally {
        setCountLoading(false);
      }
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [open, accountId, ruleField, op, value, countFn]);

  const isInboxMode = folderId === INBOX_OVERRIDE;
  // Inbox overrides only support sender or domain matches; auto-switch from subject.
  useEffect(() => {
    if (!isInboxMode) return;
    // Inbox overrides match the delivered sender, so origin matching is off here.
    if (useOrigin) setUseOrigin(false);
    if (field === "subject") {
      const nextField: Field = fromAddr ? "from" : domain ? "domain" : "from";
      setField(nextField);
      setValue(nextField === "from" ? (fromAddr ?? "") : (domain ?? ""));
    }
    if (op !== "equals") setOp("equals");
  }, [isInboxMode, field, op, fromAddr, domain, useOrigin]);

  // Auto mark-read scoping is a folder setting keyed by sender/domain, so it
  // only applies to folder targets with a sender or domain rule.
  const targetFolderName = folders.find((f) => f.id === folderId)?.name ?? "this folder";
  const showMarkRead = !!folderId && !isInboxMode && field !== "subject" && !!value.trim();

  useEffect(() => {
    if (!open || !showMarkRead || !folderId) {
      setDecision(null);
      setMarkRead(null);
      return;
    }
    let cancelled = false;
    setDecisionLoading(true);
    const h = setTimeout(async () => {
      try {
        const r = await markReadDecisionFn({
          data: { folder_id: folderId, value: value.trim() },
        });
        if (cancelled) return;
        setDecision(r);
        // Default to what the folder already does, so an untouched control is
        // a no-op rather than a silent settings change.
        setMarkRead(r.would_mark_read);
      } catch {
        if (!cancelled) {
          setDecision(null);
          setMarkRead(null);
        }
      } finally {
        if (!cancelled) setDecisionLoading(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(h);
    };
  }, [open, showMarkRead, folderId, value, markReadDecisionFn]);


  const canSave =
    !!folderId && value.trim().length > 0 && !saving && (!isInboxMode || field !== "subject");

  async function handleSave() {
    if (!folderId || !value.trim() || !accountId) return;
    setSaving(true);
    try {
      if (isInboxMode) {
        const matchType: "email" | "domain" = field === "domain" ? "domain" : "email";
        const r = await addOverrideFn({ data: { value: value.trim(), match_type: matchType } });
        toast.success(r.already ? "Already on the inbox list" : "Future mail kept in inbox");
        qc.invalidateQueries({ queryKey: ["inbox-overrides"] });
        qc.invalidateQueries({ queryKey: ["emails"] });
        qc.invalidateQueries({ queryKey: ["emails-summary"] });
        onOpenChange(false);
        if (applyToPast) {
          const trimmed = value.trim();
          void stripLabelFn({ data: { value: trimmed, match_type: matchType } })
            .then((past) => {
              if (past.stripped_count > 0) {
                toast.success(
                  `Cleaned ${past.stripped_count} past email${past.stripped_count === 1 ? "" : "s"}`,
                );
                qc.invalidateQueries({ queryKey: ["emails"] });
                qc.invalidateQueries({ queryKey: ["emails-summary"] });
              }
            })
            .catch((e: unknown) => {
              const msg = e instanceof Error ? e.message : String(e);
              toast.error(`Override saved, but cleaning past emails failed: ${msg}`);
            });
        }
        return;
      }

      const r = await addRuleFn({
        data: { folder_id: folderId, field: ruleField, value: value.trim(), op },
      });
      const folderName = folders.find((f) => f.id === folderId)?.name ?? "folder";
      toast.success(
        r.already ? `Rule already routed to ${folderName}` : `Future matches → ${folderName}`,
      );
      qc.invalidateQueries({ queryKey: ["folder-filters"] });
      qc.invalidateQueries({ queryKey: ["emails"] });
      qc.invalidateQueries({ queryKey: ["emails-summary"] });
      onOpenChange(false);

      if (applyToPast) {
        const trimmed = value.trim();
        const currentField = ruleField;
        const currentOp = op;
        const archive = archivePast;
        const targetFolderId = folderId;
        void applyPastFn({
          data: {
            account_id: accountId,
            to_folder_id: targetFolderId,
            field: currentField,
            op: currentOp,
            value: trimmed,
            archive,
          },
        })
          .then((past) => {
            const parts: string[] = [];
            if (past.moved > 0) parts.push(`${past.moved} moved`);
            if (past.archived > 0) parts.push(`${past.archived} archived`);
            if (past.failed > 0) parts.push(`${past.failed} failed`);
            if (parts.length > 0) {
              toast.success(`Past emails → ${folderName}: ${parts.join(" · ")}`);
              qc.invalidateQueries({ queryKey: ["emails"] });
              qc.invalidateQueries({ queryKey: ["emails-summary"] });
            }
          })
          .catch((e: unknown) => {
            const msg = e instanceof Error ? e.message : String(e);
            toast.error(`Rule saved, but moving past emails failed: ${msg}`);
          });
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col overflow-y-auto p-6 sm:max-w-md">
        <SheetHeader className="text-left">
          <SheetTitle>Filter messages like this</SheetTitle>
          <SheetDescription>
            Build a rule that auto-routes matching mail into one of your folders.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-5">
          {relayOnly && !isInboxMode && (
            <div className="rounded-md border border-border bg-muted/40 p-3">
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {via
                  ? `This message reached you from ${via.originName}, relayed by ${via.forwarderName} (${fromAddr}).`
                  : `This message was relayed by ${fromAddr}.`}{" "}
                A sender rule on {fromAddr} matches everything that address forwards, not just{" "}
                {via ? via.originName : "this sender"}. Match on the subject instead, or rescan
                forwarded mail in Settings → Inbox filters to recover the original address.
              </p>
            </div>
          )}

          {forwarded && !isInboxMode && (
            <div>
              <Label className="mb-2 block text-xs uppercase tracking-wider text-muted-foreground">
                Which sender
              </Label>
              <div className="grid grid-cols-2 gap-1.5">
                <FieldTab
                  active={useOrigin}
                  onClick={() => setUseOrigin(true)}
                  icon={<AtSign className="h-3.5 w-3.5" />}
                  label={via ? `Original: ${via.originName}` : "Original sender"}
                />
                <FieldTab
                  active={!useOrigin}
                  onClick={() => setUseOrigin(false)}
                  icon={<Forward className="h-3.5 w-3.5" />}
                  label={via ? `Via ${via.forwarderName}` : "Forwarded by"}
                />
              </div>
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                {useOrigin
                  ? `Matches mail originally from ${originAddr}, however it is forwarded.`
                  : `Matches everything forwarded by ${fromAddr}.`}
              </p>
            </div>
          )}


          {/* Match by */}
          <div>
            <Label className="mb-2 block text-xs uppercase tracking-wider text-muted-foreground">
              Match by
            </Label>
            <div className="grid grid-cols-3 gap-1.5">
              <FieldTab
                active={field === "from"}
                onClick={() => pickField("from")}
                icon={<AtSign className="h-3.5 w-3.5" />}
                label="Sender"
                disabled={!senderAddr}
              />
              <FieldTab
                active={field === "domain"}
                onClick={() => pickField("domain")}
                icon={<Globe className="h-3.5 w-3.5" />}
                label="Domain"
                disabled={!domain}
              />
              <FieldTab
                active={field === "subject"}
                onClick={() => pickField("subject")}
                icon={<Type className="h-3.5 w-3.5" />}
                label="Subject"
                disabled={!subject || isInboxMode}
              />
            </div>
          </div>

          {/* Value */}
          <div>
            <Label
              htmlFor="filter-value"
              className="mb-2 block text-xs uppercase tracking-wider text-muted-foreground"
            >
              {field === "from" ? "Sender address" : field === "domain" ? "Domain" : "Subject text"}
            </Label>
            <Input
              id="filter-value"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={
                field === "from"
                  ? "name@example.com"
                  : field === "domain"
                    ? "example.com"
                    : "Daily digest"
              }
              autoFocus
            />
            <div className="mt-1.5 min-h-[18px] text-xs text-muted-foreground">
              {countLoading ? (
                <span className="inline-flex items-center gap-1.5">
                  <Spinner className="h-3 w-3" /> Counting matches…
                </span>
              ) : count !== null ? (
                <>
                  {count === 0
                    ? "No existing emails match."
                    : count >= 500
                      ? "About 500+ existing emails match."
                      : `About ${count} existing email${count === 1 ? "" : "s"} match.`}
                </>
              ) : null}
            </div>
          </div>

          {/* Match type — subject only, never in inbox mode */}
          {field === "subject" && !isInboxMode && (
            <div>
              <Label className="mb-2 block text-xs uppercase tracking-wider text-muted-foreground">
                Match type
              </Label>
              <RadioGroup value={op} onValueChange={(v) => setOp(v as Op)} className="space-y-1.5">
                <OpRow
                  value="starts_with"
                  current={op}
                  label="Starts with"
                  hint="Best for newsletters with a fixed prefix."
                />
                <OpRow
                  value="contains"
                  current={op}
                  label="Contains"
                  hint="Matches anywhere in the subject."
                />
                <OpRow
                  value="equals"
                  current={op}
                  label="Exact match"
                  hint="Only an exact subject match counts."
                />
              </RadioGroup>
            </div>
          )}

          {/* Send to folder */}
          <div>
            <Label className="mb-2 block text-xs uppercase tracking-wider text-muted-foreground">
              Send to
            </Label>
            <div className="max-h-56 overflow-y-auto rounded-md border border-border">
              <button
                type="button"
                onClick={() => setFolderId(INBOX_OVERRIDE)}
                className={`flex w-full items-center gap-2 border-b border-border/50 px-3 py-2 text-left text-sm transition-colors ${
                  folderId === INBOX_OVERRIDE ? "bg-primary/10 text-primary" : "hover:bg-accent/60"
                }`}
              >
                <Inbox className="h-3.5 w-3.5 shrink-0" />
                <span className="flex-1 truncate">Inbox — always show</span>
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  keep visible
                </span>
              </button>
              {folders.length === 0 && (
                <p className="px-3 py-4 text-sm text-muted-foreground">No folders yet.</p>
              )}
              {folders.map((f) => {
                const isCurrent = f.id === currentFolderId;
                const isSelected = folderId === f.id;
                return (
                  <button
                    key={f.id}
                    type="button"
                    disabled={isCurrent}
                    onClick={() => setFolderId(f.id)}
                    className={`flex w-full items-center gap-2 border-b border-border/50 px-3 py-2 text-left text-sm last:border-b-0 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                      isSelected ? "bg-primary/10 text-primary" : "hover:bg-accent/60"
                    }`}
                  >
                    <span
                      className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ background: f.color }}
                    />
                    <span className="flex-1 truncate">{f.name}</span>
                    {isCurrent && (
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                        current
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Auto mark-read scope — folder targets only, sender/domain rules only */}
          {showMarkRead && (
            <div>
              <Label className="mb-2 block text-xs uppercase tracking-wider text-muted-foreground">
                Mark as read
              </Label>
              {decisionLoading || markRead === null ? (
                <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Spinner className="h-3 w-3" /> Checking folder settings…
                </span>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-1.5">
                    <FieldTab
                      active={markRead}
                      onClick={() => setMarkRead(true)}
                      icon={<CheckCheck className="h-3.5 w-3.5" />}
                      label="Mark read"
                    />
                    <FieldTab
                      active={!markRead}
                      onClick={() => setMarkRead(false)}
                      icon={<MailOpen className="h-3.5 w-3.5" />}
                      label="Leave unread"
                    />
                  </div>
                  <p className="mt-1.5 text-[11px] text-muted-foreground">
                    {markRead
                      ? `Mail from ${value.trim() || "this sender"} filed in ${targetFolderName} will be marked read automatically.`
                      : `Mail from ${value.trim() || "this sender"} filed in ${targetFolderName} stays unread.`}
                    {markRead !== decision?.would_mark_read
                      ? " This updates the folder's auto mark-read settings."
                      : ""}
                  </p>
                </>
              )}
            </div>
          )}


          {/* Apply to */}
          <div>
            <Label className="mb-2 block text-xs uppercase tracking-wider text-muted-foreground">
              Apply to
            </Label>
            <RadioGroup
              value={applyToPast ? "past" : "future"}
              onValueChange={(v) => setApplyToPast(v === "past")}
              className="space-y-1.5"
            >
              <OpRow
                value="future"
                current={applyToPast ? "past" : "future"}
                label="Future emails only"
              />
              <OpRow
                value="past"
                current={applyToPast ? "past" : "future"}
                label="Future and past matches"
                hint={
                  count !== null
                    ? isInboxMode
                      ? `${count >= 500 ? "500+" : count} past email${count === 1 ? "" : "s"} will be returned to the inbox.`
                      : `${count >= 500 ? "500+" : count} existing email${count === 1 ? "" : "s"} will be moved.`
                    : undefined
                }
              />
            </RadioGroup>
            {applyToPast && !isInboxMode && (
              <label className="mt-2 flex cursor-pointer items-start gap-2.5 rounded-md border border-border bg-accent/20 px-3 py-2">
                <Checkbox
                  checked={archivePast}
                  onCheckedChange={(v) => setArchivePast(v === true)}
                  className="mt-0.5"
                />
                <div className="flex-1">
                  <div className="text-sm">Also archive them</div>
                  <div className="text-[11px] text-muted-foreground">
                    Remove past matches from the inbox after moving.
                  </div>
                </div>
              </label>
            )}
          </div>
        </div>

        <SheetFooter className="mt-6 flex-row justify-end gap-2 sm:justify-end">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!canSave}>
            {saving ? (
              <>
                <Spinner className="mr-2 h-4 w-4" /> Saving…
              </>
            ) : isInboxMode ? (
              "Add to inbox list"
            ) : (
              "Create filter"
            )}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function FieldTab({
  active,
  onClick,
  icon,
  label,
  disabled,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center justify-center gap-1.5 rounded-md border px-2 py-2 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        active
          ? "border-primary bg-primary/10 text-primary"
          : "border-border text-muted-foreground hover:bg-accent"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function OpRow({
  value,
  current,
  label,
  hint,
}: {
  value: string;
  current: string;
  label: string;
  hint?: string;
}) {
  const id = `op-${value}`;
  return (
    <label
      htmlFor={id}
      className={`flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2 transition-colors ${
        current === value ? "border-primary bg-primary/5" : "border-border hover:bg-accent/40"
      }`}
    >
      <RadioGroupItem id={id} value={value} className="mt-0.5" />
      <div className="flex-1">
        <div className="text-sm">{label}</div>
        {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
      </div>
    </label>
  );
}
