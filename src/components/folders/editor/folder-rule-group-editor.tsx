import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, X } from "lucide-react";
import type { RuleNode } from "./types";

const FIELD_OPTS = [
  { value: "from", label: "from" },
  { value: "to", label: "to" },
  { value: "cc", label: "cc" },
  { value: "subject", label: "subject" },
  { value: "body", label: "body" },
  { value: "domain", label: "domain" },
  { value: "list_id", label: "list-id (newsletter)" },
  { value: "is_reply", label: "is reply" },
  { value: "has_attachment", label: "has attachment" },
];
const OP_OPTS = [
  { value: "contains", label: "contains" },
  { value: "equals", label: "equals" },
  { value: "starts_with", label: "starts with" },
  { value: "ends_with", label: "ends with" },
  { value: "not_contains", label: "does not contain" },
  { value: "not_equals", label: "does not equal" },
  { value: "domain_in", label: "domain is one of (allowlist)" },
  { value: "regex", label: "regex" },
];

export function RuleGroupEditor({
  node,
  onChange,
  onRemove,
  isRoot = false,
}: {
  node: RuleNode;
  onChange: (n: RuleNode) => void;
  onRemove?: () => void;
  isRoot?: boolean;
}) {
  if (node.type === "cond") {
    return (
      <div className="flex flex-col gap-2 rounded-md border border-border bg-background px-2 py-1.5 text-sm sm:flex-row sm:items-center">
        <Select value={node.field} onValueChange={(v) => onChange({ ...node, field: v })}>
          <SelectTrigger className="h-7 w-full text-xs sm:w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FIELD_OPTS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={node.op} onValueChange={(v) => onChange({ ...node, op: v })}>
          <SelectTrigger className="h-7 w-full text-xs sm:w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {OP_OPTS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex items-center gap-2">
          <Input
            className="h-7 min-w-0 flex-1 text-xs"
            placeholder="value"
            value={node.value}
            onChange={(e) => onChange({ ...node, value: e.target.value })}
          />
          {onRemove && (
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6 shrink-0"
              aria-label="Remove condition"
              onClick={onRemove}
            >
              <X className="h-3 w-3" />
            </Button>
          )}
        </div>
      </div>
    );
  }

  const updateChild = (i: number, c: RuleNode) => {
    const next = node.children.slice();
    next[i] = c;
    onChange({ ...node, children: next });
  };
  const removeChild = (i: number) => {
    const next = node.children.slice();
    next.splice(i, 1);
    onChange({ ...node, children: next });
  };
  const addCond = () =>
    onChange({
      ...node,
      children: [...node.children, { type: "cond", field: "from", op: "contains", value: "" }],
    });
  const addGroup = () =>
    onChange({
      ...node,
      children: [
        ...node.children,
        { type: "group", op: node.op === "and" ? "or" : "and", children: [] },
      ],
    });

  return (
    <div
      className={`rounded-md border ${isRoot ? "border-border" : "border-border/70 bg-muted/20"} p-2`}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="inline-flex rounded-md border border-border text-xs overflow-hidden">
          <button
            type="button"
            onClick={() => onChange({ ...node, op: "and" })}
            className={`px-2.5 py-0.5 ${node.op === "and" ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50"}`}
          >
            AND
          </button>
          <button
            type="button"
            onClick={() => onChange({ ...node, op: "or" })}
            className={`px-2.5 py-0.5 border-l border-border ${node.op === "or" ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50"}`}
          >
            OR
          </button>
        </div>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={addCond}>
            <Plus className="mr-1 h-3 w-3" /> Rule
          </Button>
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={addGroup}>
            <Plus className="mr-1 h-3 w-3" /> Group
          </Button>
          {!isRoot && onRemove && (
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              aria-label="Remove group"
              onClick={onRemove}
            >
              <X className="h-3 w-3" />
            </Button>
          )}
        </div>
      </div>
      <div className="space-y-1.5">
        {node.children.length === 0 && (
          <div className="rounded border border-dashed border-border/60 px-3 py-2 text-xs text-muted-foreground">
            Empty group — add a rule or nested group.
          </div>
        )}
        {node.children.map((c, i) => (
          <RuleGroupEditor
            key={i}
            node={c}
            onChange={(n) => updateChild(i, n)}
            onRemove={() => removeChild(i)}
          />
        ))}
      </div>
    </div>
  );
}
