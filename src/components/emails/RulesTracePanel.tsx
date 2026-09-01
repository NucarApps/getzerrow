// Decision history for one message (Phase C, Amendment 7).
//
// Renders a v2 RulesTrace: the ladder with the stage that decided, every
// rule that matched with its specificity badge and why the winner won, up
// to ten evaluated-but-failed rules with per-condition pass/fail, any
// runtime collision, and the AI stage's eligibility. Config only — never
// message content.
import { Check, Minus, X, AlertTriangle, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { levelLabel } from "@/lib/rules/specificity";
import { stageRows, traceHeadline } from "@/lib/rules/trace";
import type { RuleEvaluation, RulesTrace, SpecificityLevel } from "@/lib/rules/types";

function opLabel(op: string): string {
  const m: Record<string, string> = {
    contains: "contains",
    equals: "is",
    domain_in: "is",
    starts_with: "starts with",
    ends_with: "ends with",
    regex: "matches",
    not_contains: "does not contain",
    not_equals: "is not",
  };
  return m[op] ?? op.replace(/_/g, " ");
}

function LevelBadge({ level }: { level: SpecificityLevel }) {
  return (
    <Badge variant="outline" className="shrink-0 font-mono text-[10px] uppercase tracking-wide">
      {levelLabel(level)}
    </Badge>
  );
}

function ConditionRow({
  field,
  op,
  value,
  passed,
}: {
  field: string;
  op: string;
  value: string;
  passed: boolean;
}) {
  return (
    <li className="flex items-start gap-1.5">
      {passed ? (
        <Check className="mt-0.5 h-3 w-3 shrink-0 text-emerald-500" />
      ) : (
        <X className="mt-0.5 h-3 w-3 shrink-0 text-rose-500" />
      )}
      <span className="font-mono text-[11px] leading-snug">
        <span className="text-muted-foreground">{field.replace(/_/g, " ")}</span>{" "}
        <span className="text-primary">{opLabel(op)}</span>{" "}
        {value && <span className="text-foreground">"{value}"</span>}
      </span>
    </li>
  );
}

function RuleCard({ rule, winner }: { rule: RuleEvaluation; winner?: boolean }) {
  return (
    <div
      className={`rounded-md border p-2 ${
        winner ? "border-primary/50 bg-primary/5" : "border-border bg-background/40"
      }`}
    >
      <div className="mb-1 flex items-center gap-2">
        <LevelBadge level={rule.level} />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{rule.folder_name}</span>
        {winner && <span className="shrink-0 text-[10px] uppercase text-primary">Winner</span>}
      </div>
      {rule.conditions.length > 0 && (
        <ul className="space-y-0.5">
          {rule.conditions.map((c, i) => (
            <ConditionRow key={i} {...c} />
          ))}
        </ul>
      )}
    </div>
  );
}

const outcomeIcon = {
  applied: <Check className="h-3.5 w-3.5 text-emerald-500" />,
  skipped: <X className="h-3.5 w-3.5 text-amber-500" />,
  pass: <Minus className="h-3.5 w-3.5 text-muted-foreground" />,
  not_reached: <Minus className="h-3.5 w-3.5 text-muted-foreground/40" />,
} as const;

export function RulesTracePanel({ trace }: { trace: RulesTrace }) {
  const rows = stageRows(trace);
  const winnerId = trace.winner?.rule_id;

  return (
    <div className="space-y-4 text-sm">
      <p className="text-foreground/90">{traceHeadline(trace)}</p>

      {trace.collision && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="text-xs">
            <div className="font-medium">Two equally specific rules claimed this message</div>
            <p className="mt-0.5 text-muted-foreground">
              {trace.collision.reason ||
                `Both are ${levelLabel(trace.collision.level)} rules for different folders — the older rule won.`}{" "}
              Add an exception so this stops being a coin toss.
            </p>
          </div>
        </div>
      )}

      {/* The ladder */}
      <div>
        <div className="mb-1.5 text-xs uppercase tracking-wider text-muted-foreground">
          Decision ladder
        </div>
        <ol className="space-y-1">
          {rows.map((row) => (
            <li key={row.stage} className="flex items-start gap-2">
              <span className="mt-0.5 shrink-0">{outcomeIcon[row.outcome]}</span>
              <span className="min-w-0 flex-1">
                <span
                  className={`text-xs ${
                    row.outcome === "applied"
                      ? "font-medium text-foreground"
                      : row.outcome === "not_reached"
                        ? "text-muted-foreground/60"
                        : "text-muted-foreground"
                  }`}
                >
                  {row.label}
                </span>
                {row.detail && (
                  <span className="block text-xs leading-snug text-muted-foreground">
                    {row.detail}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ol>
      </div>

      {/* Matching rules, winner first */}
      {trace.matched_rules.length > 0 && (
        <div>
          <div className="mb-1.5 text-xs uppercase tracking-wider text-muted-foreground">
            {trace.matched_rules.length > 1 ? "Rules that matched" : "Rule that matched"}
          </div>
          <div className="space-y-1.5">
            {[...trace.matched_rules]
              .sort((a, b) => (a.rule_id === winnerId ? -1 : b.rule_id === winnerId ? 1 : 0))
              .map((r) => (
                <RuleCard key={r.rule_id} rule={r} winner={r.rule_id === winnerId} />
              ))}
          </div>
          {trace.winner?.reason && (
            <p className="mt-1.5 text-xs text-muted-foreground">{trace.winner.reason}</p>
          )}
        </div>
      )}

      {/* Near misses */}
      {trace.failed_rules.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer text-xs uppercase tracking-wider text-muted-foreground">
            Rules that were checked and did not match ({trace.failed_rules.length})
          </summary>
          <div className="mt-1.5 space-y-1.5">
            {trace.failed_rules.map((r) => (
              <RuleCard key={r.rule_id} rule={r} />
            ))}
          </div>
        </details>
      )}

      {trace.vetoed_folder_ids.length > 0 && (
        <div className="flex items-start gap-2 text-xs text-muted-foreground">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {trace.vetoed_folder_ids.length} folder
          {trace.vetoed_folder_ids.length === 1 ? "" : "s"} excluded this message by their own
          rules, so they could not be the destination.
        </div>
      )}

      {trace.ai && (
        <div className="border-t border-border pt-3 text-xs text-muted-foreground">
          {trace.ai.enabled
            ? `AI was allowed to score ${trace.ai.eligible_folder_ids.length} folder${
                trace.ai.eligible_folder_ids.length === 1 ? "" : "s"
              } for this message.`
            : "AI was off for this run, so only rules could file this message."}
        </div>
      )}
    </div>
  );
}
