// Tests for the inbox metadata cache (src/lib/inbox-meta-cache.ts).
//
// This module writes part of the inbox list to localStorage, which is the
// one place in the app where mail touches disk unencrypted. The backend is
// encrypt-at-rest, so the allowlist is the whole security argument: the
// first test below snapshots it, and it will fail the moment a field is
// added — which is exactly when someone has to justify persisting it.
//
// Everything else is failure handling: a corrupt entry, a full quota, and a
// server render with no localStorage at all must all degrade to "no
// placeholder", never to a thrown render.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { clearInboxMeta, loadInboxMeta, metaKeyFor, saveInboxMeta } from "./inbox-meta-cache";

type StorageOptions = { failWrite?: boolean };

/** A localStorage stand-in with the index API `evictOldest` walks. */
function makeLocalStorage(options: StorageOptions = {}) {
  const store = new Map<string, string>();
  const api = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (options.failWrite) {
        throw new DOMException("exceeded the quota", "QuotaExceededError");
      }
      store.set(key, value);
    },
    removeItem: (key: string) => void store.delete(key),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
  return { store, api };
}

let storage = makeLocalStorage();

function installStorage(options: StorageOptions = {}) {
  storage = makeLocalStorage(options);
  vi.stubGlobal("window", { localStorage: storage.api });
}

const KEY = "list-key";

/** A list row as the inbox query hands it over: metadata plus decrypted
 * content that must never reach disk. */
function listRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "email-1",
    received_at: "2026-09-02T10:00:00.000Z",
    is_read: false,
    is_archived: false,
    folder_id: "folder-1",
    thread_id: "thread-1",
    classified_by: "rules",
    has_attachment: true,
    ai_confidence: 0.9,
    matched_filter_ids: ["filter-1"],
    matched_folder_ids: ["folder-1"],
    snoozed_until: null,
    raw_labels: ["INBOX"],
    gmail_message_id: "gm-1",
    processed_at: "2026-09-02T10:00:01.000Z",
    // Content and identity — none of this may be persisted.
    from_addr: "jane@acme.test",
    from_name: "Jane Roe",
    subject: "Q3 numbers",
    snippet: "Here are the numbers you asked for",
    ai_summary: "Jane sent the Q3 numbers",
    classification_reason: "sender is a known contact",
    to_addrs: ["me@acme.test"],
    body_text: "…",
    body_html: "<p>…</p>",
    ...overrides,
  };
}

function persistedFields(key = KEY): string[] {
  const raw = storage.store.get(`atzro:inbox-meta:${key}`)!;
  const parsed = JSON.parse(raw) as { rows: Array<Record<string, unknown>> };
  return Object.keys(parsed.rows[0] ?? {}).sort();
}

beforeEach(() => {
  installStorage();
});

/* -------------------------------------------------------------------------- */
/* The allowlist                                                               */
/* -------------------------------------------------------------------------- */

describe("saveInboxMeta — what reaches disk", () => {
  it("persists exactly the metadata allowlist and nothing else", () => {
    saveInboxMeta(KEY, [listRow()]);

    // Snapshot of the allowlist. A new field here means a new field on the
    // user's disk: add it only if it carries no message content and no
    // sender or recipient identity.
    expect(persistedFields()).toStrictEqual([
      "ai_confidence",
      "classified_by",
      "folder_id",
      "gmail_message_id",
      "has_attachment",
      "id",
      "is_archived",
      "is_read",
      "matched_filter_ids",
      "matched_folder_ids",
      "processed_at",
      "raw_labels",
      "received_at",
      "snoozed_until",
      "thread_id",
    ]);
  });

  it("drops a field the server starts returning that nobody allowlisted", () => {
    saveInboxMeta(KEY, [listRow({ decrypted_body_preview: "secret" })]);

    expect(persistedFields()).not.toContain("decrypted_body_preview");
  });

  it("omits an allowlisted key the row simply does not carry", () => {
    saveInboxMeta(KEY, [{ id: "email-1", received_at: "2026-09-02T10:00:00.000Z" }]);

    expect(persistedFields()).toStrictEqual(["id", "received_at"]);
  });
});

/* -------------------------------------------------------------------------- */
/* Round trip                                                                  */
/* -------------------------------------------------------------------------- */

describe("loadInboxMeta", () => {
  it("reconstructs a placeholder row with the content fields nulled out", () => {
    saveInboxMeta(KEY, [listRow()]);

    const [row] = loadInboxMeta(KEY)!;

    expect(row).toStrictEqual({
      id: "email-1",
      received_at: "2026-09-02T10:00:00.000Z",
      is_read: false,
      is_archived: false,
      folder_id: "folder-1",
      thread_id: "thread-1",
      classified_by: "rules",
      has_attachment: true,
      ai_confidence: 0.9,
      matched_filter_ids: ["filter-1"],
      matched_folder_ids: ["folder-1"],
      snoozed_until: null,
      raw_labels: ["INBOX"],
      gmail_message_id: "gm-1",
      processed_at: "2026-09-02T10:00:01.000Z",
      from_addr: null,
      from_name: null,
      subject: null,
      snippet: null,
      ai_summary: null,
      classification_reason: null,
      to_addrs: null,
      body_text: null,
      body_html: null,
      __placeholder: true,
    });
  });

  it("returns undefined for a key that was never written", () => {
    expect(loadInboxMeta("never-written")).toBeUndefined();
  });

  it("returns undefined rather than throwing when the entry is corrupt", () => {
    storage.store.set(`atzro:inbox-meta:${KEY}`, "{not json");

    expect(loadInboxMeta(KEY)).toBeUndefined();
  });

  it("returns undefined when the stored payload is not a row list", () => {
    storage.store.set(`atzro:inbox-meta:${KEY}`, JSON.stringify({ at: 1, rows: "nope" }));

    expect(loadInboxMeta(KEY)).toBeUndefined();
  });

  it("returns undefined for an empty page so the caller waits for the query", () => {
    saveInboxMeta(KEY, []);

    expect(loadInboxMeta(KEY)).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* Failure handling and housekeeping                                           */
/* -------------------------------------------------------------------------- */

describe("inbox meta cache — degradation", () => {
  it("swallows a quota failure: the DB read is the backstop", () => {
    installStorage({ failWrite: true });

    expect(() => saveInboxMeta(KEY, [listRow()])).not.toThrow();
    expect(loadInboxMeta(KEY)).toBeUndefined();
  });

  it("does nothing at all on the server, where there is no localStorage", () => {
    vi.stubGlobal("window", undefined);

    expect(() => saveInboxMeta(KEY, [listRow()])).not.toThrow();
    expect(loadInboxMeta(KEY)).toBeUndefined();
    expect(() => clearInboxMeta()).not.toThrow();
  });

  it("evicts the oldest pages once more than ten are stored", () => {
    vi.useFakeTimers();
    for (let i = 0; i < 12; i++) {
      vi.setSystemTime(new Date(2026, 0, 1, 0, 0, i));
      saveInboxMeta(`page-${i}`, [listRow({ id: `email-${i}` })]);
    }

    const kept = [...storage.store.keys()].map((k) => k.replace("atzro:inbox-meta:", ""));
    expect(kept).toHaveLength(10);
    expect(kept).not.toContain("page-0");
    expect(kept).not.toContain("page-1");
    expect(kept).toContain("page-11");
  });

  it("treats an unreadable entry as the oldest when evicting", () => {
    vi.useFakeTimers();
    storage.store.set("atzro:inbox-meta:corrupt", "{not json");
    for (let i = 0; i < 10; i++) {
      vi.setSystemTime(new Date(2026, 0, 1, 0, 0, i));
      saveInboxMeta(`page-${i}`, [listRow()]);
    }

    expect([...storage.store.keys()]).not.toContain("atzro:inbox-meta:corrupt");
  });

  it("clears only this app's entries on sign-out", () => {
    saveInboxMeta(KEY, [listRow()]);
    storage.store.set("someone-elses-key", "keep me");

    clearInboxMeta();

    expect([...storage.store.keys()]).toStrictEqual(["someone-elses-key"]);
  });
});

describe("metaKeyFor", () => {
  it("mirrors the non-search inbox query key, cursor included", () => {
    expect(metaKeyFor("acct-1", "all", 0, null)).toBe("acct-1::all::page:0:start");
    expect(metaKeyFor("acct-1", "folder-9", 2, "cursor-abc")).toBe(
      "acct-1::folder-9::page:2:cursor-abc",
    );
  });

  it("gives two accounts different keys for the same folder and page", () => {
    expect(metaKeyFor("acct-1", "all", 0, null)).not.toBe(metaKeyFor("acct-2", "all", 0, null));
  });
});
