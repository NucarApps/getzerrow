import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Bot, Filter as FilterIcon, Tag, Hand, HelpCircle, Clock, Layers } from "lucide-react";
import { TriggeredBy } from "@/components/emails/triggered-by";
import type { RuleNode } from "@/lib/sync/types";

type DrawerFolder = { id: string; name: string; color: string };

type FolderRule = {
  id: string;
  name: string;
  ai_rule: string | null;
  gmail_label_id: string | null;
  filter_tree: RuleNode | null;
} | null;

export type AiDecisionEmail = {
  classified_by: string | null;
  classification_reason: string | null;
  ai_confidence: number | null;
  folder_id: string | null;
  matched_folder_ids: string[] | null;
  matched_filter_ids: string[] | null;
  processed_at: string | null;
  received_at: string | null;
  from_addr: string | null;
  from_name: string | null;
  to_addrs: string | null;
  subject: string | null;
  body_text?: string | null;
  has_attachment: boolean;
};

const methodMeta: Record<string, { label: string; Icon: typeof Bot; cls: string }> = {
  ai: { label: "Classified by AI", Icon: Bot, cls: "text-primary" },
  filter: { label: "Classified by a rule", Icon: FilterIcon, cls: "text-foreground" },
  domain_rule: { label: "Classified by a domain rule", Icon: FilterIcon, cls: "text-foreground" },
  gmail_label: { label: "Mapped from a Gmail label", Icon: Tag, cls: "text-foreground" },
  manual_move: { label: "Moved manually", Icon: Hand, cls: "text-foreground" },
  excluded: {
    label: "Kept in inbox by an exclude rule",
    Icon: HelpCircle,
    cls: "text-destructive",
  },
  global_exclude: {
    label: "Kept in inbox by your inbox list",
    Icon: HelpCircle,
    cls: "text-destructive",
  },
  none: { label: "Not classified yet", Icon: HelpCircle, cls: "text-muted-foreground" },
};

function confidenceBand(score: number): { label: string; bar: string; text: string } {
  if (score >= 0.85)
    return {
      label: "High",
      bar: "bg-emerald-500",
      text: "text-emerald-600 dark:text-emerald-400",
    };
  if (score >= 0.6)
    return { label: "Medium", bar: "bg-amber-500", text: "text-amber-600 dark:text-amber-400" };
  return { label: "Low", bar: "bg-rose-500", text: "text-rose-600 dark:text-rose-400" };
}

function syncDelayLabel(processedAt: string, receivedAt: string): string {
  const delta = Math.max(
    0,
    Math.round((new Date(processedAt).getTime() - new Date(receivedAt).getTime()) / 1000),
  );
  if (delta < 90) return `${delta}s`;
  if (delta < 3600) return `${Math.round(delta / 60)} min`;
  return `${Math.round(delta / 3600)}h`;
}

export function AiDecisionDrawer({
  open,
  onOpenChange,
  email,
  folders,
  folderRule,
  filters,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  email: AiDecisionEmail;
  folders: DrawerFolder[];
  folderRule: FolderRule;
  filters: Array<{ id: string; field: string; op: string; value: string }>;
}) {
  const method = methodMeta[email.classified_by ?? "none"] ?? methodMeta.none;
  const MethodIcon = method.Icon;
  const winner = email.folder_id ? folders.find((f) => f.id === email.folder_id) : null;
  const showConfidence = email.classified_by === "ai" && email.ai_confidence != null;
  const confidencePct = email.ai_confidence != null ? Math.round(email.ai_confidence * 100) : 0;
  const band = confidenceBand(email.ai_confidence ?? 0);

  const others = (email.matched_folder_ids ?? [])
    .filter((id) => id !== email.folder_id)
    .map((id) => folders.find((f) => f.id === id))
    .filter((f): f is DrawerFolder => !!f);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-primary" />
            AI decision
          </SheetTitle>
          <SheetDescription>How this email was sorted and why.</SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-5 text-sm">
          {/* Outcome */}
          <div className="rounded-lg border border-border bg-card/40 p-3">
            <div className="mb-1 text-xs uppercase tracking-wider text-muted-foreground">
              Outcome
            </div>
            {winner ? (
              <span
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2 py-0.5 text-sm"
                title={winner.name}
              >
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: winner.color }}
                />
                <span className="truncate">{winner.name}</span>
              </span>
            ) : (
              <span className="text-muted-foreground">Kept in inbox</span>
            )}
            <div className={`mt-2 flex items-center gap-1.5 text-xs ${method.cls}`}>
              <MethodIcon className="h-3.5 w-3.5" />
              {method.label}
            </div>
          </div>

          {/* Confidence */}
          {showConfidence && (
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-xs uppercase tracking-wider text-muted-foreground">
                  Confidence
                </span>
                <span className={`text-xs font-medium ${band.text}`}>
                  {band.label} · {confidencePct}%
                </span>
              </div>
              <div
                className="h-2 w-full overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-valuenow={confidencePct}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div className={`h-full ${band.bar}`} style={{ width: `${confidencePct}%` }} />
              </div>
            </div>
          )}

          {/* Rules that fired / why the folder was chosen */}
          <TriggeredBy
            classifiedBy={email.classified_by}
            reason={email.classification_reason}
            folder={folderRule}
            filters={filters}
            email={email}
          />

          {/* Runner-up folders */}
          {others.length > 0 && (
            <div>
              <div className="mb-1 flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted-foreground">
                <Layers className="h-3.5 w-3.5" />
                Also matched
              </div>
              <div className="flex flex-wrap gap-1.5">
                {others.map((f) => (
                  <span
                    key={f.id}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2 py-0.5 text-xs"
                    title={`${f.name} rules also matched — lost on priority`}
                  >
                    <span className="h-2 w-2 rounded-full" style={{ background: f.color }} />
                    <span className="max-w-[10rem] truncate">{f.name}</span>
                  </span>
                ))}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Winner chosen by folder priority.
              </p>
            </div>
          )}

          {/* Timing */}
          {email.processed_at && email.received_at && (
            <div className="flex items-center gap-1.5 border-t border-border pt-3 text-xs text-muted-foreground">
              <Clock className="h-3.5 w-3.5 shrink-0" />
              Sorted {syncDelayLabel(email.processed_at, email.received_at)} after Gmail received it
              · {new Date(email.processed_at).toLocaleString()}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
