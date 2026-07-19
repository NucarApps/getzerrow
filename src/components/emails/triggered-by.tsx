import { useMemo } from "react";
import { collectMatchingLeaves } from "@/lib/sync/filter-engine";
import type { RuleNode } from "@/lib/sync/types";

function opLabel(op: string) {
  const m: Record<string, string> = {
    contains: "contains",
    equals: "equals",
    starts_with: "starts with",
    ends_with: "ends with",
    regex: "matches regex",
    not_contains: "does not contain",
    not_equals: "does not equal",
  };
  return m[op] ?? op;
}

// Mirror of applyFilter in src/lib/sync.server.ts — keep in sync.
function applyFilterClient(
  email: {
    from_addr: string | null;
    from_name: string | null;
    to_addrs: string | null;
    subject: string | null;
    body_text?: string | null;
    has_attachment: boolean;
  },
  f: { field: string; op: string; value: string },
): boolean {
  const v = (f.value || "").toLowerCase();
  const fieldVal = (() => {
    switch (f.field) {
      case "from":
        return `${email.from_addr ?? ""} ${email.from_name ?? ""}`.toLowerCase();
      case "to":
        return (email.to_addrs ?? "").toLowerCase();
      case "subject":
        return (email.subject ?? "").toLowerCase();
      case "body":
        return (email.body_text ?? "").toLowerCase();
      case "domain":
        return ((email.from_addr ?? "").split("@")[1] ?? "").toLowerCase();
      case "has_attachment":
        return email.has_attachment ? "true" : "false";
      default:
        return "";
    }
  })();
  switch (f.op) {
    case "contains":
      return fieldVal.includes(v);
    case "equals":
      return fieldVal === v;
    case "not_contains":
      return !fieldVal.includes(v);
    case "not_equals":
      return fieldVal !== v;
    case "regex":
      try {
        return new RegExp(f.value, "i").test(fieldVal);
      } catch {
        return false;
      }
    default:
      return false;
  }
}

const EXCLUDE_OPS_CLIENT = new Set(["not_contains", "not_equals"]);

type TriggeredByEmail = {
  from_addr: string | null;
  from_name: string | null;
  to_addrs: string | null;
  subject: string | null;
  body_text?: string | null;
  has_attachment: boolean;
  matched_filter_ids: string[] | null;
};

export function TriggeredBy({
  classifiedBy,
  reason,
  folder,
  filters,
  email,
}: {
  classifiedBy: string | null;
  reason: string | null;
  folder: {
    id: string;
    name: string;
    ai_rule: string | null;
    gmail_label_id: string | null;
    filter_tree: RuleNode | null;
  } | null;
  filters: Array<{ id: string; field: string; op: string; value: string }>;
  email: TriggeredByEmail;
}) {
  const by = classifiedBy ?? "none";

  const { matched, rulesChanged } = useMemo(() => {
    if (by !== "filter" && by !== "domain_rule") return { matched: [], rulesChanged: false };
    const persisted = email.matched_filter_ids ?? [];
    if (persisted.length > 0) {
      const byId = new Map(filters.map((f) => [f.id, f]));
      const hits = persisted.map((id) => byId.get(id)).filter(Boolean) as typeof filters;
      if (hits.length > 0) return { matched: hits, rulesChanged: false };
      // Persisted ids exist but rules have since been removed/edited.
      return { matched: [], rulesChanged: true };
    }
    // Tree-based folder: re-evaluate the tree to pinpoint matching leaves.
    // Tree leaves have no folder_filters row id, so synthesize entries.
    if (folder?.filter_tree) {
      const emailForFilter = {
        from_addr: email.from_addr ?? "",
        from_name: email.from_name ?? "",
        to_addrs: email.to_addrs ?? "",
        subject: email.subject ?? "",
        body_text: email.body_text ?? "",
        has_attachment: email.has_attachment,
      };
      const leaves = collectMatchingLeaves(emailForFilter, folder.filter_tree);
      if (leaves.length > 0) {
        return {
          matched: leaves.map((l, i) => ({ id: `tree-${i}`, ...l })),
          rulesChanged: false,
        };
      }
    }
    // Legacy email: recompute the matching includes client-side.
    const includes = filters.filter((f) => !EXCLUDE_OPS_CLIENT.has(f.op));
    return { matched: includes.filter((f) => applyFilterClient(email, f)), rulesChanged: false };
  }, [by, email, filters, folder]);

  if (by === "filter" || by === "domain_rule") {
    const showAllFallback = matched.length === 0 && filters.length > 0;
    const list = matched.length > 0 ? matched : filters;
    return (
      <div className="space-y-2">
        <div className="text-xs uppercase tracking-wider text-muted-foreground">
          {matched.length > 1 ? "Rules that matched" : "Rule that matched"}
        </div>
        {reason && <p className="text-foreground/90">{reason}</p>}
        {list.length > 0 && (
          <ul className="space-y-1">
            {list.map((f, i) => (
              <li
                key={i}
                className="rounded border border-border bg-background/40 px-2 py-1 font-mono text-xs"
              >
                <span className="text-muted-foreground">{f.field}</span>{" "}
                <span className="text-primary">{opLabel(f.op)}</span>{" "}
                <span className="text-foreground">"{f.value}"</span>
              </li>
            ))}
          </ul>
        )}
        {showAllFallback && (
          <p className="text-xs italic text-muted-foreground">
            {rulesChanged
              ? "The rule that originally matched this email has since been removed or edited."
              : "Couldn't pinpoint the exact rule — showing all rules for this folder."}
          </p>
        )}
      </div>
    );
  }

  if (by === "ai") {
    return (
      <div className="space-y-2">
        {folder?.ai_rule && (
          <div>
            <div className="mb-1 text-xs uppercase tracking-wider text-muted-foreground">
              Folder AI prompt
            </div>
            <p className="rounded border border-border bg-background/40 px-2 py-1.5 text-foreground/90 italic">
              "{folder.ai_rule}"
            </p>
          </div>
        )}
        <div>
          <div className="mb-1 text-xs uppercase tracking-wider text-muted-foreground">
            Why the AI picked this folder
          </div>
          {reason ? (
            <p className="text-foreground/90">{reason}</p>
          ) : (
            <p className="italic text-muted-foreground">
              No reasoning recorded for this email. Newly synced emails will include one.
            </p>
          )}
        </div>
      </div>
    );
  }

  if (by === "gmail_label") {
    return (
      <div className="space-y-1">
        <div className="text-xs uppercase tracking-wider text-muted-foreground">Gmail label</div>
        <p className="text-foreground/90">
          {reason ?? `Mapped from Gmail label${folder?.name ? ` to "${folder.name}"` : ""}.`}
        </p>
      </div>
    );
  }

  if (by === "manual_move") {
    return (
      <div className="space-y-1">
        <div className="text-xs uppercase tracking-wider text-muted-foreground">Moved manually</div>
        <p className="text-foreground/90">{reason ?? "You moved this email into the folder."}</p>
      </div>
    );
  }

  if (by === "excluded") {
    return (
      <div className="space-y-1">
        <div className="text-xs uppercase tracking-wider text-destructive">
          Kept in inbox by exclude rule
        </div>
        <p className="text-foreground/90">
          {reason ?? "An exclude rule on a matching folder kept this email in your inbox."}
        </p>
      </div>
    );
  }

  if (by === "global_exclude") {
    return (
      <div className="space-y-1">
        <div className="text-xs uppercase tracking-wider text-destructive">
          Always send to inbox
        </div>
        <p className="text-foreground/90">
          {reason ??
            "This sender is on your global inbox list, so folder rules and AI sorting are skipped."}
        </p>
      </div>
    );
  }

  return <p className="italic text-muted-foreground">This email hasn't been classified yet.</p>;
}
