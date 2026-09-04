// Test-only chainable fake of the Supabase admin client, generalized from
// the ad-hoc builders in sync/history-concurrency.test.ts and
// sync/batch-ai-idempotency.test.ts so new tests stop re-implementing it.
//
// Reads (`select`) resolve from seeded per-table rows with real filtering
// for eq/neq/gt/gte/lt/lte/in/is/not/like/ilike/contains/or/match plus
// order/limit/range. Unimplemented modifiers are recorded pass-throughs
// unless the fake is constructed with `strict: true`, in which case they
// throw so a gap can never silently return every row.
//
// Writes (`insert`/`update`/`upsert`/`delete`) are recorded into `calls`
// and resolve `{ error: null }` unless a per-table handler says otherwise.
// By default they do NOT mutate the seeded rows; pass `applyWrites: true`
// to have them applied (insert appends, update patches matching rows,
// delete removes them, upsert merges on the `onConflict` columns or `id`),
// which makes read-after-write inside one server fn observable.
//
// RPCs dispatch to handlers registered via `onRpc` (or the `rpc` init map)
// and are always recorded in order. `auth.admin.{listUsers,getUserById,
// deleteUser}` dispatch to `onAuth` handlers and are recorded in
// `calls.auth`.
//
// Table names given to `seed` / `on*` are typed against the generated
// `Database` type (plus the `CatalogRelation` names for pg_* and
// information_schema, which production health checks read directly) so a
// typo fails typecheck instead of seeding a table nothing reads.
// `from(table)` itself stays `string` because production code is what
// calls it.
//
// `rlsScope(table, userId)` makes one table behave as RLS would, which is
// what a handler taking `context.supabase` relies on for isolation;
// `asClient()` hands the fake to code that takes a `SupabaseClient`
// parameter rather than importing the mocked module.
//
// Lives in __fixtures__ so it is excluded from the coverage/test globs and
// never ships. Consume it from a test like this — the deferred wrapper is
// REQUIRED because `vi.mock` factories are hoisted above `const fake`:
//
//   const fake = makeSupabaseFake();
//   vi.mock("@/integrations/supabase/client.server", () => ({
//     supabaseAdmin: mockSupabaseAdmin(() => fake),
//   }));
//
// (`mockSupabaseAdmin` takes a thunk for the same hoisting reason; it
// forwards `from`/`rpc`/`auth`/`storage` lazily on every call.)

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

type PublicTables = Database["public"]["Tables"];
export type TableName = keyof PublicTables;
export type RowOf<T extends TableName> = PublicTables[T]["Row"];
/** A seeded row: any subset of the real columns, each also accepting
 * `null` (tests routinely seed null for NOT NULL columns they don't care
 * about). Unknown keys are rejected by excess-property checking, which is
 * the point: a typo can no longer seed a column nothing reads. */
export type SeedRow<T extends TableName> = { [K in keyof RowOf<T>]?: RowOf<T>[K] | null };
export type RpcName = keyof Database["public"]["Functions"];

/** Relations OUTSIDE the `public` schema that production code reads
 * directly — Postgres catalog views and information_schema. They are not in
 * the generated `Database` type, so they are enumerated here rather than
 * widening every table parameter to `string`, which would give back the
 * typo protection those parameters exist for. Add a name when a module
 * starts reading it. */
export type CatalogRelation =
  | "pg_views"
  | "pg_proc"
  | "pg_indexes"
  | "pg_tables"
  | "information_schema.columns"
  | "information_schema.tables";

/** Anything `from()` may address: a real table, or one of the catalog
 * relations above. */
export type FakeTable = TableName | CatalogRelation;

export type FakeRow = Record<string, unknown>;

export type FakeError = { message: string; code?: string; details?: string };

export type RpcResult = { data?: unknown; error?: FakeError | null };

export type RpcHandler = (args: Record<string, unknown>) => RpcResult | unknown;

export type Filter = { op: string; col?: string; value?: unknown; extra?: unknown };

/** Returned by a write handler. `FakeError` (has `message`) fails the
 * write; `{ data }` overrides the rows a trailing `.select()` resolves
 * (e.g. to inject a DB-generated id); nullish keeps the default. Throw to
 * simulate a network-level rejection. */
export type WriteHandlerResult = FakeError | { data: unknown } | null | undefined | void;
export type WriteHandler = (payload: unknown, filters: Filter[]) => WriteHandlerResult;

/** How a PostgREST embed (`select("…, contacts:contacts(id, name)")`)
 * resolves: the row's `<fk>` column is looked up in `table` by `on`. */
export type EmbedSpec = {
  /** Table the embedded rows come from. */
  table: TableName;
  /** Column on the OUTER row holding the key. Defaults to `${alias}_id`,
   * then the singular form (`contacts:contacts(…)` on a row that carries
   * `contact_id`, which is the shape this schema uses). */
  localKey?: string;
  /** Column on the INNER row matched against it (default "id"). */
  foreignKey?: string;
  /** Many rather than one: return an array of matches. */
  many?: boolean;
};

/** Returned by a select handler: an error fails the read, `{ data }`
 * overrides the resolved rows, nullish keeps the seeded result. */
export type SelectHandlerResult = FakeError | { data: FakeRow[] } | null | undefined | void;
export type SelectHandler = (filters: Filter[], columns: string | undefined) => SelectHandlerResult;

export type AuthHandler = (args: unknown) => { data?: unknown; error?: FakeError | null } | unknown;

/** Storage call, recorded per bucket so a test can assert which object was
 * touched. `args` is whatever the method was given (key, keys, bytes…). */
export type StorageMethod = "upload" | "download" | "remove" | "createSignedUrl" | "getPublicUrl";
export type RecordedStorage = { bucket: string; method: string; args: unknown[] };
export type StorageHandler = (
  ...args: unknown[]
) => { data?: unknown; error?: FakeError | null } | unknown;

export type RecordedSelect = {
  table: string;
  columns: string | undefined;
  filters: Filter[];
  /** Row cap the query asked for, when it called `.limit()`. */
  limit?: number;
  /** `[from, to]` when the query called `.range()`. */
  range?: [number, number];
};
export type RecordedWrite = {
  table: string;
  payload: unknown;
  options?: unknown;
  filters: Filter[];
};
export type RecordedRpc = { fn: string; args: Record<string, unknown> };
export type RecordedAuth = { method: string; args: unknown };

/** The filter surface shared by read and write builders. */
export type FilterOps<B> = {
  eq(col: string, value: unknown): B;
  neq(col: string, value: unknown): B;
  gt(col: string, value: unknown): B;
  gte(col: string, value: unknown): B;
  lt(col: string, value: unknown): B;
  lte(col: string, value: unknown): B;
  in(col: string, value: unknown): B;
  is(col: string, value: unknown): B;
  like(col: string, value: unknown): B;
  ilike(col: string, value: unknown): B;
  contains(col: string, value: unknown): B;
  match(query: Record<string, unknown>): B;
  not(col: string, op: string, value: unknown): B;
  or(expr: string): B;
  /** Generic `.filter(col, op, value)`; maps to the same ops. */
  filter(col: string, op: string, value: unknown): B;
};

export type SingleResult = { data: FakeRow | null; error: FakeError | null };
export type ManyResult = { data: FakeRow[] | null; error: FakeError | null; count: number | null };

export interface SelectBuilder extends FilterOps<SelectBuilder> {
  order(col: string, o?: { ascending?: boolean }): SelectBuilder;
  limit(n: number): SelectBuilder;
  range(from: number, to: number): SelectBuilder;
  single(): Promise<SingleResult>;
  maybeSingle(): Promise<SingleResult>;
  then<T>(resolve: (v: ManyResult) => T, reject?: (e: unknown) => T): Promise<T>;
}

export type WriteSelectBuilder = {
  single(): Promise<SingleResult>;
  maybeSingle(): Promise<SingleResult>;
  then<T>(resolve: (v: ManyResult) => T, reject?: (e: unknown) => T): Promise<T>;
};

export type WriteResult = { data: null; error: FakeError | null; count: number | null };

export interface WriteBuilder extends FilterOps<WriteBuilder> {
  select(columns?: string): WriteSelectBuilder;
  then<T>(resolve: (v: WriteResult) => T, reject?: (e: unknown) => T): Promise<T>;
}

export type SupabaseFakeInit = {
  tables?: Partial<{ [T in TableName]: SeedRow<T>[] }>;
  rpc?: Partial<Record<RpcName, RpcHandler>>;
  /** Apply writes to the seeded rows (default false: record only). */
  applyWrites?: boolean;
  /** Narrow each read to the columns its `select()` named, the way
   * PostgREST does (default false). Worth turning on for a suite that
   * asserts a returned row's SHAPE — without it a test can assert a field
   * the query never selected and pass. */
  projectColumns?: boolean;
  /** Throw on any filter/modifier the fake does not implement (default:
   * record it as a pass-through). */
  strict?: boolean;
};

/** PostgREST `.single()` error code for "zero rows". */
export const PGRST_NO_ROWS = "PGRST116";

function likeToRegExp(pattern: string, caseInsensitive: boolean): RegExp {
  // SQL LIKE: `%` = any run, `_` = one char; everything else literal.
  const src = pattern
    .split("")
    .map((ch) => (ch === "%" ? ".*" : ch === "_" ? "." : ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${src}$`, caseInsensitive ? "is" : "s");
}

/** Parse a PostgREST `.or("a.eq.1,b.is.null,and(c.gt.2,d.lt.5)")` string
 * into a filter tree. Values are kept as strings (PostgREST semantics) and
 * compared loosely against row values. */
type OrNode = { kind: "and" | "or"; parts: Array<OrNode | Filter> };
function parseLogic(expr: string, kind: "and" | "or"): OrNode {
  const parts: Array<OrNode | Filter> = [];
  let depth = 0;
  let cur = "";
  const flush = () => {
    const s = cur.trim();
    cur = "";
    if (!s) return;
    const nested = /^(and|or)\((.*)\)$/s.exec(s);
    if (nested) {
      parts.push(parseLogic(nested[2]!, nested[1] as "and" | "or"));
      return;
    }
    const m = /^([^.]+)\.(not\.)?([a-z]+)\.(.*)$/s.exec(s);
    if (!m) throw new Error(`supabase-fake: cannot parse or() term "${s}"`);
    const [, col, negate, op, raw] = m;
    // Inside a filter STRING, PostgREST spells the LIKE wildcard `*`
    // (a literal % would have to be percent-encoded). The column-method
    // form `.ilike(col, "%x%")` uses % — both reach the same matcher.
    let value: unknown = op === "like" || op === "ilike" ? raw!.replace(/\*/g, "%") : raw;
    if (op === "in") {
      value = raw!
        .replace(/^\(|\)$/g, "")
        .split(",")
        .map((v) => v.trim().replace(/^"|"$/g, ""));
    } else if (op === "is") {
      value = raw === "null" ? null : raw === "true" ? true : raw === "false" ? false : raw;
    }
    parts.push({ op: negate ? `not.${op}` : op!, col: col!, value });
  };
  for (const ch of expr) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      flush();
      continue;
    }
    cur += ch;
  }
  flush();
  return { kind, parts };
}

function looseEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return String(a) === String(b);
}

function cmp(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  const na = Number(a);
  const nb = Number(b);
  if (typeof a === "number" && !Number.isNaN(nb)) return a - nb;
  if (typeof b === "number" && !Number.isNaN(na)) return na - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

export function makeSupabaseFake(init?: SupabaseFakeInit) {
  const tables = new Map<string, FakeRow[]>();
  const rpcHandlers = new Map<string, RpcHandler>();
  const writeHandlers = new Map<string, WriteHandler>(); // key: `${kind}:${table}`
  const selectHandlers = new Map<string, SelectHandler>();
  const authHandlers = new Map<string, AuthHandler>();
  const storageHandlers = new Map<string, StorageHandler>(); // key: `${bucket}:${method}`
  const embeds = new Map<string, EmbedSpec>(); // key: `${table}:${alias}`
  const applyWrites = init?.applyWrites === true;
  const projectColumns = init?.projectColumns === true;
  const strict = init?.strict === true;

  const calls = {
    selects: [] as RecordedSelect[],
    inserts: [] as RecordedWrite[],
    updates: [] as RecordedWrite[],
    upserts: [] as RecordedWrite[],
    deletes: [] as RecordedWrite[],
    rpcs: [] as RecordedRpc[],
    auth: [] as RecordedAuth[],
    storage: [] as RecordedStorage[],
  };

  function seed<T extends TableName>(table: T, rows: SeedRow<T>[]) {
    tables.set(
      table,
      rows.map((r) => ({ ...(r as FakeRow) })),
    );
  }
  /** Escape hatch for a relation the generated types don't know (a view, a
   * catalog relation, or a table added by a migration newer than
   * types.ts). Prefer `seed`. */
  function seedRaw(table: FakeTable | (string & {}), rows: FakeRow[]) {
    tables.set(
      table,
      rows.map((r) => ({ ...r })),
    );
  }
  /** Current contents of a table (a copy). With `applyWrites` this is how
   * a test observes the post-write state. */
  function rows<T extends TableName>(table: T): Array<Partial<RowOf<T>>> {
    return (tables.get(table) ?? []).map((r) => ({ ...r })) as Array<Partial<RowOf<T>>>;
  }
  /** Raw contents of any relation, including one outside the generated
   * types. `rows` is the typed form and the one to prefer. */
  function rowsRaw(table: FakeTable | (string & {})): FakeRow[] {
    return (tables.get(table) ?? []).map((r) => ({ ...r }));
  }

  for (const [table, seedRows] of Object.entries(init?.tables ?? {})) {
    seedRaw(table, (seedRows ?? []) as FakeRow[]);
  }
  for (const [fn, handler] of Object.entries(init?.rpc ?? {})) {
    if (handler) rpcHandlers.set(fn, handler);
  }

  function onRpc(fn: RpcName | (string & {}), handler: RpcHandler) {
    rpcHandlers.set(fn, handler);
  }
  function onSelect(table: FakeTable, handler: SelectHandler) {
    selectHandlers.set(table, handler);
  }
  function onInsert(table: FakeTable, handler: WriteHandler) {
    writeHandlers.set(`insert:${table}`, handler);
  }
  function onUpdate(table: FakeTable, handler: WriteHandler) {
    writeHandlers.set(`update:${table}`, handler);
  }
  function onUpsert(table: FakeTable, handler: WriteHandler) {
    writeHandlers.set(`upsert:${table}`, handler);
  }
  function onDelete(table: FakeTable, handler: WriteHandler) {
    writeHandlers.set(`delete:${table}`, handler);
  }
  function onAuth(
    method: "listUsers" | "getUserById" | "deleteUser" | (string & {}),
    handler: AuthHandler,
  ) {
    authHandlers.set(method, handler);
  }
  /** Stub one storage method on one bucket, e.g.
   * `onStorage("contact-cards", "createSignedUrl", () => ({ data: { signedUrl: "…" } }))`.
   * Unstubbed methods resolve `{ data: null, error: null }` and are still
   * recorded in `calls.storage`. */
  function onStorage(
    bucket: string,
    method: StorageMethod | (string & {}),
    handler: StorageHandler,
  ) {
    storageHandlers.set(`${bucket}:${method}`, handler);
  }
  /**
   * Teach the fake one PostgREST embed so a `select("…, alias:table(cols)")`
   * resolves instead of coming back undefined — which silently makes a join
   * look empty rather than failing.
   *
   *   fake.onEmbed("contact_group_members", "contacts", { table: "contacts" });
   */
  function onEmbed(table: FakeTable, alias: string, spec: EmbedSpec) {
    embeds.set(`${table}:${alias}`, spec);
  }

  function reset() {
    tables.clear();
    rpcHandlers.clear();
    writeHandlers.clear();
    selectHandlers.clear();
    authHandlers.clear();
    storageHandlers.clear();
    embeds.clear();
    for (const arr of Object.values(calls)) arr.length = 0;
  }

  /** Read a filter's column off a row, following one level of embed —
   * PostgREST lets a filter address an embedded table's column
   * (`.is("contacts.avatar_url", null)`), and reading that as a flat key
   * made the predicate a pass-through that matched everything. */
  function columnValue(row: FakeRow, col: string): unknown {
    if (col in row) return row[col];
    const dot = col.indexOf(".");
    if (dot < 0) return undefined;
    const outer = row[col.slice(0, dot)];
    const rest = col.slice(dot + 1);
    if (Array.isArray(outer)) {
      return (outer as FakeRow[]).map((r) => columnValue(r, rest))[0];
    }
    if (outer && typeof outer === "object") return columnValue(outer as FakeRow, rest);
    return undefined;
  }

  function matchOne(row: FakeRow, f: Filter): boolean {
    const v = f.col !== undefined ? columnValue(row, f.col) : undefined;
    switch (f.op) {
      case "eq":
        return looseEq(v, f.value);
      case "neq":
        return !looseEq(v, f.value);
      case "gt":
        return cmp(v, f.value) > 0;
      case "gte":
        return cmp(v, f.value) >= 0;
      case "lt":
        return cmp(v, f.value) < 0;
      case "lte":
        return cmp(v, f.value) <= 0;
      case "in":
        return Array.isArray(f.value) && (f.value as unknown[]).some((x) => looseEq(x, v));
      case "is":
        if (f.value === null) return v === null || v === undefined;
        return v === f.value;
      case "like":
      case "ilike":
        if (typeof v !== "string") return false;
        return likeToRegExp(String(f.value), f.op === "ilike").test(v);
      case "contains":
        // Array column ⊇ value; jsonb object ⊇ value; text substring.
        if (Array.isArray(v)) {
          const want = Array.isArray(f.value) ? f.value : [f.value];
          return (want as unknown[]).every((x) => (v as unknown[]).some((y) => looseEq(x, y)));
        }
        if (v && typeof v === "object" && f.value && typeof f.value === "object") {
          return Object.entries(f.value as FakeRow).every(([k, x]) =>
            looseEq((v as FakeRow)[k], x),
          );
        }
        if (typeof v === "string") return v.includes(String(f.value));
        return false;
      case "match":
        return Object.entries((f.value ?? {}) as FakeRow).every(([k, x]) =>
          looseEq(columnValue(row, k), x),
        );
      case "not": {
        // `.not(col, op, value)` negates the inner op.
        const inner = { op: String(f.extra ?? "is"), col: f.col, value: f.value };
        return !matchOne(row, inner);
      }
      case "or":
        return matchLogic(row, parseLogic(String(f.value), "or"));
      default: {
        if (f.op.startsWith("not.")) {
          return !matchOne(row, { ...f, op: f.op.slice(4) });
        }
        if (strict) throw new Error(`supabase-fake: unimplemented filter "${f.op}"`);
        return true; // pass-through modifier
      }
    }
  }

  function matchLogic(row: FakeRow, node: OrNode): boolean {
    const test = (p: OrNode | Filter) =>
      "kind" in p ? matchLogic(row, p) : matchOne(row, p as Filter);
    return node.kind === "and" ? node.parts.every(test) : node.parts.some(test);
  }

  function rowMatches(row: FakeRow, filters: Filter[]): boolean {
    return filters.every((f) => matchOne(row, f));
  }

  /** Filter methods shared by the read and write builders. `self` is a
   * thunk so the builder object can be annotated and self-referential. */
  function filterMethods<B>(filters: Filter[], self: () => B): FilterOps<B> {
    const push = (op: string, col: string | undefined, value: unknown, extra?: unknown) => {
      filters.push({ op, col, value, extra });
      return self();
    };
    return {
      eq: (col, value) => push("eq", col, value),
      neq: (col, value) => push("neq", col, value),
      gt: (col, value) => push("gt", col, value),
      gte: (col, value) => push("gte", col, value),
      lt: (col, value) => push("lt", col, value),
      lte: (col, value) => push("lte", col, value),
      in: (col, value) => push("in", col, value),
      is: (col, value) => push("is", col, value),
      like: (col, value) => push("like", col, value),
      ilike: (col, value) => push("ilike", col, value),
      contains: (col, value) => push("contains", col, value),
      match: (query) => push("match", undefined, query),
      not: (col, op, value) => push("not", col, value, op),
      or: (expr) => push("or", undefined, expr),
      filter: (col, op, value) => {
        if (op.startsWith("not.")) return push("not", col, value, op.slice(4));
        return push(op, col, value);
      },
    };
  }

  /** Top-level columns a `select()` string asks for, or null for `*` /
   * absent. Embeds are handled separately by `withEmbeds`. */
  function projectedColumns(columns: string | undefined): string[] | null {
    if (!columns) return null;
    const out: string[] = [];
    let depth = 0;
    let cur = "";
    let star = false;
    const flush = () => {
      const t = cur.trim();
      cur = "";
      // A bare `*` anywhere at the top level widens the whole select, even
      // alongside named columns (`"*, id"` is every column, not just `id`).
      if (t === "*") star = true;
      if (!t || t === "*" || t.includes("(")) return;
      // `alias:column` renames a plain column; the row still carries the
      // source name, so keep that.
      const parts = t.split(":");
      out.push((parts.length > 1 ? parts[1]! : parts[0]!).trim());
    };
    for (const ch of columns) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === "," && depth === 0) {
        flush();
        continue;
      }
      cur += ch;
    }
    flush();
    return !star && out.length > 0 ? out : null;
  }

  /** Narrow a row to the columns its `select()` named, keeping the embed
   * aliases `withEmbeds` resolved. `*` (or an absent select) keeps
   * everything, as PostgREST does. Opt-in via `projectColumns`: without it
   * a test can assert a field its query never selected and still pass,
   * which is false safety — but many existing suites seed whole rows and
   * read unselected fields, so the looser behaviour stays the default. */
  function project(columns: string | undefined, row: FakeRow): FakeRow {
    const cols = projectedColumns(columns);
    if (!cols) return row;
    const out: FakeRow = {};
    for (const key of [...cols, ...embedAliases(columns)]) {
      if (key in row) out[key] = row[key];
    }
    return out;
  }

  /** Aliases named by a `select()` string: `"a, alias:tbl(x,y), b"`. */
  function embedAliases(columns: string | undefined): string[] {
    if (!columns) return [];
    // Both spellings PostgREST accepts: the aliased `alias:table(cols)` form
    // and the bare `table(cols)` / `table!inner(cols)` form, where the alias
    // IS the table name. Missing the second meant an inner join silently
    // resolved to undefined, which reads as "no matching rows".
    const aliased = [...columns.matchAll(/([A-Za-z_]\w*)\s*:\s*[A-Za-z_]\w*(?:!\w+)?\s*\(/g)].map(
      (m) => m[1]!,
    );
    const bare = [...columns.matchAll(/(?:^|,)\s*([A-Za-z_]\w*)(?:!\w+)?\s*\(/g)].map((m) => m[1]!);
    return [...new Set([...aliased, ...bare])];
  }

  /** Resolve every registered embed the select asked for onto a copy of the row. */
  function withEmbeds(table: string, columns: string | undefined, row: FakeRow): FakeRow {
    const aliases = embedAliases(columns);
    if (aliases.length === 0) return row;
    const out = { ...row };
    for (const alias of aliases) {
      const spec = embeds.get(`${table}:${alias}`);
      if (!spec) continue;
      const candidates = spec.localKey
        ? [spec.localKey]
        : [`${alias}_id`, `${alias.replace(/s$/, "")}_id`];
      const localKey = candidates.find((c) => c in row);
      const foreignKey = spec.foreignKey ?? "id";
      if (!localKey) {
        throw new Error(
          `supabase-fake: embed "${alias}" on ${table} found no key column ` +
            `(tried ${candidates.join(", ")}) — pass localKey to onEmbed`,
        );
      }
      const key = row[localKey];
      const matches = (tables.get(spec.table) ?? []).filter((r) => looseEq(r[foreignKey], key));
      out[alias] = spec.many ? matches : (matches[0] ?? null);
    }
    return out;
  }

  function makeSelectBuilder(table: string, columns: string | undefined, options?: unknown) {
    const filters: Filter[] = [];
    let orderBy: { col: string; ascending: boolean } | null = null;
    let limitN: number | null = null;
    let offsetN = 0;
    const opts = options as { count?: string; head?: boolean } | undefined;
    const recorded: RecordedSelect = { table, columns, filters };
    calls.selects.push(recorded);

    function resolveRows(): { rows: FakeRow[]; error: FakeError | null; total: number } {
      const handler = selectHandlers.get(table);
      let base = tables.get(table) ?? [];
      if (handler) {
        const r = handler(filters, columns);
        if (r && typeof r === "object" && "message" in r) {
          return { rows: [], error: r as FakeError, total: 0 };
        }
        if (r && typeof r === "object" && "data" in r) base = (r as { data: FakeRow[] }).data;
      }
      let out = base
        .filter((r) => rowMatches(r, filters))
        .map((r) => withEmbeds(table, columns, r))
        .map((r) => (projectColumns ? project(columns, r) : r));
      const total = out.length;
      if (orderBy) {
        const { col, ascending } = orderBy;
        out = [...out].sort((a, b) => (ascending ? cmp(a[col], b[col]) : cmp(b[col], a[col])));
      }
      if (offsetN > 0) out = out.slice(offsetN);
      if (limitN !== null) out = out.slice(0, limitN);
      return { rows: out, error: null, total };
    }

    const builder: SelectBuilder = {
      ...filterMethods(filters, () => builder),
      order(col, o) {
        orderBy = { col, ascending: o?.ascending !== false };
        return builder;
      },
      limit(n) {
        limitN = n;
        // Recorded on the select entry (NOT in `filters`, which tests
        // compare wholesale) so a test can assert the cap a query asked for
        // rather than inferring it from the row count.
        recorded.limit = n;
        return builder;
      },
      range(from, to) {
        offsetN = from;
        limitN = to - from + 1;
        recorded.range = [from, to];
        return builder;
      },
      async single() {
        const { rows: out, error } = resolveRows();
        if (error) return { data: null, error };
        if (out.length === 1) return { data: out[0]!, error: null };
        return {
          data: null,
          error: {
            message:
              out.length === 0
                ? `JSON object requested, multiple (or no) rows returned (no rows in ${table})`
                : `JSON object requested, multiple (or no) rows returned (${out.length} rows in ${table})`,
            code: PGRST_NO_ROWS,
          },
        };
      },
      async maybeSingle() {
        const { rows: out, error } = resolveRows();
        if (error) return { data: null, error };
        return { data: out[0] ?? null, error: null };
      },
      then(resolve, reject) {
        const { rows: out, error, total } = resolveRows();
        const count = opts?.count ? total : null;
        const result: ManyResult = error
          ? { data: null, error, count: null }
          : opts?.head
            ? { data: null, error: null, count }
            : { data: out, error: null, count };
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return builder;
  }

  function makeWriteBuilder(
    kind: "insert" | "update" | "upsert" | "delete",
    table: string,
    payload: unknown,
    options?: unknown,
  ) {
    const filters: Filter[] = [];
    let recorded = false;
    let settled: Promise<{ data: FakeRow[]; error: FakeError | null; count: number }> | null = null;

    function record() {
      if (recorded) return;
      recorded = true;
      const entry: RecordedWrite = { table, payload, options, filters };
      if (kind === "insert") calls.inserts.push(entry);
      else if (kind === "update") calls.updates.push(entry);
      else if (kind === "upsert") calls.upserts.push(entry);
      else calls.deletes.push(entry);
    }

    function payloadRows(): FakeRow[] {
      if (payload === null || payload === undefined) return [];
      return (Array.isArray(payload) ? payload : [payload]).map((r) => ({ ...(r as FakeRow) }));
    }

    function apply(): FakeRow[] {
      const current = tables.get(table) ?? [];
      if (kind === "insert") {
        const added = payloadRows();
        tables.set(table, [...current, ...added]);
        return added;
      }
      if (kind === "update") {
        const patch = (payload ?? {}) as FakeRow;
        const touched: FakeRow[] = [];
        const next = current.map((r) => {
          if (!rowMatches(r, filters)) return r;
          const merged = { ...r, ...patch };
          touched.push(merged);
          return merged;
        });
        tables.set(table, next);
        return touched;
      }
      if (kind === "delete") {
        const removed = current.filter((r) => rowMatches(r, filters));
        tables.set(
          table,
          current.filter((r) => !rowMatches(r, filters)),
        );
        return removed;
      }
      // upsert: merge on onConflict columns (default "id").
      const conflict = String((options as { onConflict?: string } | undefined)?.onConflict ?? "id")
        .split(",")
        .map((s) => s.trim());
      const out: FakeRow[] = [];
      const next = [...current];
      for (const row of payloadRows()) {
        const idx = next.findIndex((r) => conflict.every((c) => looseEq(r[c], row[c])));
        if (idx >= 0) {
          next[idx] = { ...next[idx], ...row };
          out.push(next[idx]!);
        } else {
          next.push(row);
          out.push(row);
        }
      }
      tables.set(table, next);
      return out;
    }

    function settle() {
      if (settled) return settled;
      record();
      settled = (async () => {
        const handler = writeHandlers.get(`${kind}:${table}`);
        let override: FakeRow[] | null = null;
        if (handler) {
          // A throwing handler simulates a network-level rejection.
          const r = handler(payload, filters);
          if (r && typeof r === "object" && "message" in r) {
            return { data: [], error: r as FakeError, count: 0 };
          }
          if (r && typeof r === "object" && "data" in r) {
            const d = (r as { data: unknown }).data;
            override = d === null || d === undefined ? [] : Array.isArray(d) ? d : [d as FakeRow];
          }
        }
        const affected = applyWrites
          ? apply()
          : kind === "update" || kind === "delete"
            ? (tables.get(table) ?? [])
                .filter((r) => rowMatches(r, filters))
                .map((r) => (kind === "update" ? { ...r, ...((payload ?? {}) as FakeRow) } : r))
            : payloadRows();
        const data = override ?? affected;
        return { data, error: null, count: data.length };
      })();
      return settled;
    }

    /** `columns` is what a returning write asked for — `.insert(x).select("id")`
     * resolves to `{ id }` alone under `projectColumns`, as PostgREST does. */
    function selectBuilder(columns?: string): WriteSelectBuilder {
      const narrow = (rows: FakeRow[]) =>
        projectColumns ? rows.map((r) => project(columns, r)) : rows;
      return {
        async single() {
          const { data, error } = await settle();
          if (error) return { data: null, error };
          return { data: narrow(data)[0] ?? null, error: null };
        },
        async maybeSingle() {
          const { data, error } = await settle();
          if (error) return { data: null, error };
          return { data: narrow(data)[0] ?? null, error: null };
        },
        then(resolve, reject) {
          return settle()
            .then(({ data, error, count }): ManyResult =>
              error
                ? { data: null, error, count: null }
                : { data: narrow(data), error: null, count },
            )
            .then(resolve, reject);
        },
      };
    }

    const builder: WriteBuilder = {
      ...filterMethods(filters, () => builder),
      select: (columns) => selectBuilder(columns),
      then(resolve, reject) {
        return settle()
          .then(({ error, count }): WriteResult => ({
            data: null,
            error,
            count: error ? null : count,
          }))
          .then(resolve, reject);
      },
    };
    return builder;
  }

  async function storageCall(bucket: string, method: StorageMethod, args: unknown[]) {
    calls.storage.push({ bucket, method, args });
    const handler = storageHandlers.get(`${bucket}:${method}`);
    if (!handler) return { data: null, error: null };
    const result = handler(...args);
    if (result && typeof result === "object" && ("data" in result || "error" in result)) {
      const r = result as { data?: unknown; error?: FakeError | null };
      return { data: r.data ?? null, error: r.error ?? null };
    }
    return { data: result ?? null, error: null };
  }

  async function authCall(method: string, args: unknown) {
    calls.auth.push({ method, args });
    const handler = authHandlers.get(method);
    if (!handler) return { data: null, error: null };
    const result = handler(args);
    if (result && typeof result === "object" && ("data" in result || "error" in result)) {
      const r = result as { data?: unknown; error?: FakeError | null };
      return { data: r.data ?? null, error: r.error ?? null };
    }
    return { data: result ?? null, error: null };
  }

  const supabaseAdmin = {
    from(table: string) {
      return {
        select: (columns?: string, options?: unknown) => makeSelectBuilder(table, columns, options),
        insert: (payload: unknown, options?: unknown) =>
          makeWriteBuilder("insert", table, payload, options),
        update: (payload: unknown, options?: unknown) =>
          makeWriteBuilder("update", table, payload, options),
        upsert: (payload: unknown, options?: unknown) =>
          makeWriteBuilder("upsert", table, payload, options),
        delete: (options?: unknown) => makeWriteBuilder("delete", table, null, options),
      };
    },
    async rpc(fn: string, args: Record<string, unknown> = {}) {
      calls.rpcs.push({ fn, args });
      const handler = rpcHandlers.get(fn);
      if (!handler) return { data: null, error: null };
      const result = handler(args);
      if (result && typeof result === "object" && ("data" in result || "error" in result)) {
        const r = result as RpcResult;
        return { data: r.data ?? null, error: r.error ?? null };
      }
      return { data: result ?? null, error: null };
    },
    auth: {
      admin: {
        listUsers: (args?: unknown) => authCall("listUsers", args),
        getUserById: (id: string) => authCall("getUserById", id),
        deleteUser: (id: string) => authCall("deleteUser", id),
      },
    },
    storage: {
      from(bucket: string) {
        const call =
          (method: StorageMethod) =>
          (...args: unknown[]) =>
            storageCall(bucket, method, args);
        return {
          upload: call("upload"),
          download: call("download"),
          remove: call("remove"),
          createSignedUrl: call("createSignedUrl"),
          // Synchronous in the real client — no await, no error channel.
          getPublicUrl(key: string) {
            calls.storage.push({ bucket, method: "getPublicUrl", args: [key] });
            const handler = storageHandlers.get(`${bucket}:getPublicUrl`);
            const result = handler?.(key);
            if (result && typeof result === "object" && "data" in result) {
              return result as { data: { publicUrl: string } };
            }
            return { data: { publicUrl: `https://storage.test/${bucket}/${key}` } };
          },
        };
      },
    },
  };

  /** Emulate row-level security for one table: rows whose `user_id` is not
   * `userId` become invisible to every read of it.
   *
   * Handlers that take the user-scoped client (`context.supabase`) lean on
   * RLS for tenant isolation and add no `user_id` filter of their own.
   * Without this a seeded foreign row comes back and the "not found" branch
   * can never be reached honestly — the test would pass while proving
   * nothing. Do NOT apply it to a table a handler reads with the
   * service-role client on purpose (a global uniqueness check, say). */
  function rlsScope(table: FakeTable, userId: string) {
    onSelect(table, () => ({
      data: rowsRaw(table).filter((r) => r["user_id"] === userId),
    }));
  }

  return {
    supabaseAdmin,
    /** The same object under the user-scoped client's name, for hooks and
     * RLS-client server fns (`context.supabase`). */
    client: supabaseAdmin,
    /** The fake typed as a real `SupabaseClient`, for the handful of call
     * sites that take one as a parameter rather than importing the module
     * this fake mocks. The cast is here so it is written once. */
    asClient: () => supabaseAdmin as unknown as SupabaseClient<Database>,
    calls,
    seed,
    seedRaw,
    rows,
    rowsRaw,
    rlsScope,
    reset,
    onRpc,
    onSelect,
    onInsert,
    onUpdate,
    onUpsert,
    onDelete,
    onAuth,
    onStorage,
    onEmbed,
  };
}

export type SupabaseFake = ReturnType<typeof makeSupabaseFake>;

/** Hoist-safe module mock body: every method resolves the fake lazily, so
 * it can appear inside a `vi.mock` factory that runs before the test
 * file's `const fake = makeSupabaseFake()` initializer. */
export function mockSupabaseAdmin(get: () => SupabaseFake) {
  return {
    from: (table: string) => get().supabaseAdmin.from(table),
    rpc: (fn: string, args?: Record<string, unknown>) => get().supabaseAdmin.rpc(fn, args),
    auth: {
      admin: {
        listUsers: (args?: unknown) => get().supabaseAdmin.auth.admin.listUsers(args),
        getUserById: (id: string) => get().supabaseAdmin.auth.admin.getUserById(id),
        deleteUser: (id: string) => get().supabaseAdmin.auth.admin.deleteUser(id),
      },
    },
    storage: {
      from: (bucket: string) => get().supabaseAdmin.storage.from(bucket),
    },
  };
}

/** Sum of every recorded write, for "nothing was mutated" assertions. */
export function writeCount(fake: SupabaseFake): number {
  const { inserts, updates, upserts, deletes } = fake.calls;
  return inserts.length + updates.length + upserts.length + deletes.length;
}

/** Recorded writes of one kind against one table. */
export function writesTo(
  fake: SupabaseFake,
  kind: "inserts" | "updates" | "upserts" | "deletes",
  table: TableName,
): RecordedWrite[] {
  return fake.calls[kind].filter((w) => w.table === table);
}
