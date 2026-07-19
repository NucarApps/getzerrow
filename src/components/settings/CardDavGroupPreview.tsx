import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Users } from "lucide-react";
import { listContactGroups } from "@/lib/contact-groups.functions";
import { buildGroupTree } from "@/lib/contacts/group-tree";
import { formatGroupDisplayName, type GroupNameStyle } from "@/lib/carddav/group-name";

/**
 * Live preview of the contact groups exactly as they'll appear on the
 * iPhone, using the same pure formatter as the CardDAV handler. Reacts to
 * the currently selected name style so the user can sanity-check before
 * the next sync.
 */
export function CardDavGroupPreview({ style }: { style: GroupNameStyle }) {
  const listGroups = useServerFn(listContactGroups);
  const gq = useQuery({ queryKey: ["contact-groups"], queryFn: () => listGroups() });

  const rows = useMemo(() => {
    const groups = gq.data?.groups ?? [];
    const byId = new Map(
      groups.map((g) => [g.id, { name: g.name, parent: g.parent_group_id ?? null }]),
    );
    return buildGroupTree(groups).map(({ group }) => ({
      id: group.id,
      display: formatGroupDisplayName(byId, group.id, group.name, style),
      count: group.count,
    }));
  }, [gq.data, style]);

  if (gq.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading groups…</p>;
  }
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No groups yet — labels you create in Contacts will show up on your iPhone as groups.
      </p>
    );
  }
  return (
    <div>
      <ul className="max-h-48 divide-y divide-border/60 overflow-y-auto rounded-md border border-border">
        {rows.map((r) => (
          <li key={r.id} className="flex items-center gap-2 px-3 py-1.5 text-sm">
            <span className="min-w-0 flex-1 truncate">{r.display}</span>
            <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
              <Users className="h-3 w-3" />
              {r.count}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-1.5 text-[11px] text-muted-foreground">
        iPhone shows groups as a flat list — this is exactly what you'll see.
      </p>
    </div>
  );
}
