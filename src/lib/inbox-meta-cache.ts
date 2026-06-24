// Metadata-only persistence of the inbox list.
//
// Why: the inbox list query (`emailsQ` in inbox.tsx) renders decrypted
// subject / snippet / sender content. We deliberately do NOT write that to
// disk — the whole backend is encrypt-at-rest, and persisting decrypted
// content to the browser would undo that. But we CAN persist the non-content
// row metadata (order, read/unread, folder, dates, flags) so a hard reload
// paints the inbox *structure* at 0ms: a synchronous localStorage read used as
// React Query `placeholderData`, while the real content hydrates from the DB
// round-trip ~200ms later. Reconstructed rows are tagged `__placeholder` so the
// row UI can shimmer the sender/subject until content arrives.
//
// Cleared on sign-out (see __root.tsx). localStorage (not IndexedDB) on purpose:
// it reads synchronously, which is what makes the first paint 0ms.

const PREFIX = "zerrow:inbox-meta:";
const MAX_KEYS = 10;

// Non-sensitive fields safe to persist (no decrypted content, no sender /
// recipient identity). This is an allowlist — never widen it to content fields.
const META_FIELDS = [
  "id",
  "received_at",
  "is_read",
  "is_archived",
  "folder_id",
  "thread_id",
  "classified_by",
  "has_attachment",
  "ai_confidence",
  "matched_filter_ids",
  "matched_folder_ids",
  "snoozed_until",
  "raw_labels",
  "gmail_message_id",
  "processed_at",
] as const;

// Content / identity fields deliberately dropped on persist and reconstructed
// as null on load, so a placeholder row is still a structurally-valid list row.
const NULLED_FIELDS = [
  "from_addr",
  "from_name",
  "subject",
  "snippet",
  "ai_summary",
  "classification_reason",
  "to_addrs",
  "body_text",
  "body_html",
] as const;

function available(): boolean {
  return typeof window !== "undefined" && !!window.localStorage;
}

/** Stable key mirroring the non-search `emailsQ` query-key segments. */
export function metaKeyFor(
  accountId: string,
  selectedFolder: string,
  page: number,
  cursor: string | null,
): string {
  return `${accountId}::${selectedFolder}::page:${page}:${cursor ?? "start"}`;
}

/** Persist only the metadata allowlist for a rendered list page. */
export function saveInboxMeta(key: string, rows: ReadonlyArray<Record<string, unknown>>): void {
  if (!available()) return;
  try {
    const slim = rows.map((row) => {
      const out: Record<string, unknown> = {};
      for (const f of META_FIELDS) if (f in row) out[f] = row[f];
      return out;
    });
    window.localStorage.setItem(PREFIX + key, JSON.stringify({ at: Date.now(), rows: slim }));
    evictOldest();
  } catch {
    // Quota / serialization failure is non-fatal — the DB read is the backstop.
  }
}

/**
 * Read persisted metadata back as placeholder rows. Content / identity fields
 * are filled with null and each row is tagged `__placeholder: true`. Returns
 * undefined when nothing is stored (or on the server, where localStorage is
 * absent) so callers fall through to the live query.
 */
export function loadInboxMeta(key: string): Record<string, unknown>[] | undefined {
  if (!available()) return undefined;
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { rows?: unknown };
    if (!Array.isArray(parsed.rows) || parsed.rows.length === 0) return undefined;
    const nulled: Record<string, null> = {};
    for (const f of NULLED_FIELDS) nulled[f] = null;
    return parsed.rows.map((r) => ({
      ...nulled,
      ...(r as Record<string, unknown>),
      __placeholder: true,
    }));
  } catch {
    return undefined;
  }
}

/** Remove all persisted inbox metadata (call on sign-out). */
export function clearInboxMeta(): void {
  if (!available()) return;
  try {
    for (const k of prefixedKeys()) window.localStorage.removeItem(k);
  } catch {
    // ignore
  }
}

function prefixedKeys(): string[] {
  const keys: string[] = [];
  for (let i = 0; i < window.localStorage.length; i++) {
    const k = window.localStorage.key(i);
    if (k && k.startsWith(PREFIX)) keys.push(k);
  }
  return keys;
}

function evictOldest(): void {
  const keys = prefixedKeys();
  if (keys.length <= MAX_KEYS) return;
  const withAge = keys.map((k) => ({ k, at: readAge(k) })).sort((a, b) => a.at - b.at); // oldest first
  for (const { k } of withAge.slice(0, withAge.length - MAX_KEYS)) {
    window.localStorage.removeItem(k);
  }
}

function readAge(k: string): number {
  try {
    return (JSON.parse(window.localStorage.getItem(k) || "{}") as { at?: number }).at ?? 0;
  } catch {
    return 0;
  }
}
