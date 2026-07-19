/**
 * Pure, client-safe formatting of a group's iPhone display name. iOS
 * Contacts only shows a flat group list, so nested Zerrow groups get their
 * path flattened per the user's `group_name_style` setting. The CardDAV
 * handler delegates here, and the settings-page preview uses the same
 * function, so what the preview shows is exactly what syncs.
 */

// User-selectable format for group vCards on iPhone:
//   leaf       -> "Toyota"
//   path_slash -> "Factory / Toyota" (default)
//   path_dash  -> "Factory - Toyota"
export type GroupNameStyle = "leaf" | "path_slash" | "path_dash";

export type GroupNameNode = { name: string; parent: string | null };

export function formatGroupDisplayName(
  byId: Map<string, GroupNameNode>,
  groupId: string,
  ownName: string,
  style: GroupNameStyle,
): string {
  if (style === "leaf") return ownName;
  const own = byId.get(groupId);
  if (!own) return ownName;
  const parts: string[] = [];
  let cursor: string | null = groupId;
  let hops = 0;
  while (cursor && hops < 8) {
    const node = byId.get(cursor);
    if (!node) break;
    parts.unshift(node.name);
    cursor = node.parent;
    hops++;
  }
  const sep = style === "path_dash" ? " - " : " / ";
  return parts.length > 1 ? parts.join(sep) : ownName;
}
