// Test-only chainable fake of the Supabase admin client, generalized from
// the ad-hoc builders in sync/history-concurrency.test.ts and
// sync/batch-ai-idempotency.test.ts so new tests stop re-implementing it.
//
// Reads (`select`) resolve from seeded per-table rows with real filtering for
// eq/neq/gt/gte/lt/lte/in/is plus order/limit; every other modifier is a
// recorded pass-through. Writes (`insert`/`update`/`upsert`/`delete`) do NOT
// mutate the seeded rows — they are recorded into `calls` and resolve
// `{ error: null }` unless a per-table handler says otherwise. RPCs dispatch
// to handlers registered via `onRpc` (or the `rpc` init map) and are always
// recorded in order.
//
// Lives in __fixtures__ so it is excluded from the `src/**/*.test.ts` glob
// and never ships: only test files import it, inside vi.mock factories:
//
//   const fake = makeSupabaseFake();
//   vi.mock("@/integrations/supabase/client.server", () => ({
//     supabaseAdmin: fake.supabaseAdmin,
//   }));

export type FakeRow = Record<string, unknown>;

export type FakeError = { message: string; code?: string };

export type RpcResult = { data?: unknown; error?: FakeError | null };

export type RpcHandler = (args: Record<string, unknown>) => RpcResult | unknown;

/** May return an error to fail the write, or throw to simulate a network throw. */
export type WriteHandler = (
  payload: unknown,
  filters: Array<{ op: string; col?: string; value?: unknown }>,
) => FakeError | null | undefined | void;

export type RecordedSelect = {
  table: string;
  columns: string | undefined;
  filters: Array<{ op: string; col?: string; value?: unknown }>;
};
export type RecordedWrite = {
  table: string;
  payload: unknown;
  options?: unknown;
  filters: Array<{ op: string; col?: string; value?: unknown }>;
};
export type RecordedRpc = { fn: string; args: Record<string, unknown> };

export type SupabaseFake = ReturnType<typeof makeSupabaseFake>;

export function makeSupabaseFake(init?: {
  tables?: Record<string, FakeRow[]>;
  rpc?: Record<string, RpcHandler>;
}) {
  const tables = new Map<string, FakeRow[]>();
  const rpcHandlers = new Map<string, RpcHandler>();
  const writeHandlers = new Map<string, WriteHandler>(); // key: `${kind}:${table}`

  const calls = {
    selects: [] as RecordedSelect[],
    inserts: [] as RecordedWrite[],
    updates: [] as RecordedWrite[],
    upserts: [] as RecordedWrite[],
    deletes: [] as RecordedWrite[],
    rpcs: [] as RecordedRpc[],
  };

  function seed(table: string, rows: FakeRow[]) {
    tables.set(
      table,
      rows.map((r) => ({ ...r })),
    );
  }
  for (const [table, rows] of Object.entries(init?.tables ?? {})) seed(table, rows);
  for (const [fn, handler] of Object.entries(init?.rpc ?? {})) rpcHandlers.set(fn, handler);

  function onRpc(fn: string, handler: RpcHandler) {
    rpcHandlers.set(fn, handler);
  }
  function onInsert(table: string, handler: WriteHandler) {
    writeHandlers.set(`insert:${table}`, handler);
  }
  function onUpdate(table: string, handler: WriteHandler) {
    writeHandlers.set(`update:${table}`, handler);
  }
  function onUpsert(table: string, handler: WriteHandler) {
    writeHandlers.set(`upsert:${table}`, handler);
  }
  function onDelete(table: string, handler: WriteHandler) {
    writeHandlers.set(`delete:${table}`, handler);
  }

  function reset() {
    tables.clear();
    rpcHandlers.clear();
    writeHandlers.clear();
    for (const arr of Object.values(calls)) arr.length = 0;
  }

  type Filter = { op: string; col?: string; value?: unknown };

  function cmp(a: unknown, b: unknown): number {
    if (typeof a === "number" && typeof b === "number") return a - b;
    return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
  }

  function rowMatches(row: FakeRow, filters: Filter[]): boolean {
    for (const f of filters) {
      const v = f.col !== undefined ? row[f.col] : undefined;
      switch (f.op) {
        case "eq":
          if (v !== f.value) return false;
          break;
        case "neq":
          if (v === f.value) return false;
          break;
        case "gt":
          if (!(cmp(v, f.value) > 0)) return false;
          break;
        case "gte":
          if (!(cmp(v, f.value) >= 0)) return false;
          break;
        case "lt":
          if (!(cmp(v, f.value) < 0)) return false;
          break;
        case "lte":
          if (!(cmp(v, f.value) <= 0)) return false;
          break;
        case "in":
          if (!Array.isArray(f.value) || !(f.value as unknown[]).includes(v)) return false;
          break;
        case "is":
          if (f.value === null && v !== null && v !== undefined) return false;
          break;
        case "not":
          // Only `.not(col, "is", null)` is given filtering semantics.
          if (f.value === null && (v === null || v === undefined)) return false;
          break;
        default:
          break; // pass-through modifier
      }
    }
    return true;
  }

  function makeSelectBuilder(table: string, columns: string | undefined, options?: unknown) {
    const filters: Filter[] = [];
    let orderBy: { col: string; ascending: boolean } | null = null;
    let limitN: number | null = null;
    const opts = options as { count?: string; head?: boolean } | undefined;
    calls.selects.push({ table, columns, filters });

    function resolveRows(): FakeRow[] {
      let rows = (tables.get(table) ?? []).filter((r) => rowMatches(r, filters));
      if (orderBy) {
        const { col, ascending } = orderBy;
        rows = [...rows].sort((a, b) => (ascending ? cmp(a[col], b[col]) : cmp(b[col], a[col])));
      }
      if (limitN !== null) rows = rows.slice(0, limitN);
      return rows;
    }

    const builder = {
      eq: (col: string, value: unknown) => pushFilter("eq", col, value),
      neq: (col: string, value: unknown) => pushFilter("neq", col, value),
      gt: (col: string, value: unknown) => pushFilter("gt", col, value),
      gte: (col: string, value: unknown) => pushFilter("gte", col, value),
      lt: (col: string, value: unknown) => pushFilter("lt", col, value),
      lte: (col: string, value: unknown) => pushFilter("lte", col, value),
      in: (col: string, value: unknown) => pushFilter("in", col, value),
      is: (col: string, value: unknown) => pushFilter("is", col, value),
      not: (col: string, _op: string, value: unknown) => pushFilter("not", col, value),
      contains: (col: string, value: unknown) => pushFilter("contains", col, value),
      ilike: (col: string, value: unknown) => pushFilter("ilike", col, value),
      or: (expr: string) => pushFilter("or", undefined, expr),
      order(col: string, o?: { ascending?: boolean }) {
        orderBy = { col, ascending: o?.ascending !== false };
        return builder;
      },
      limit(n: number) {
        limitN = n;
        return builder;
      },
      range(from: number, to: number) {
        limitN = to - from + 1;
        return builder;
      },
      async single() {
        const rows = resolveRows();
        return rows.length > 0
          ? { data: rows[0], error: null }
          : { data: null, error: { message: `no rows in ${table}` } };
      },
      async maybeSingle() {
        const rows = resolveRows();
        return { data: rows[0] ?? null, error: null };
      },
      then<T>(
        resolve: (v: { data: FakeRow[] | null; error: null; count: number | null }) => T,
      ): Promise<T> {
        const rows = resolveRows();
        if (opts?.head && opts?.count) {
          return Promise.resolve({ data: null, error: null, count: rows.length }).then(resolve);
        }
        return Promise.resolve({ data: rows, error: null, count: rows.length }).then(resolve);
      },
    };
    function pushFilter(op: string, col: string | undefined, value: unknown) {
      filters.push({ op, col, value });
      return builder;
    }
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
    function record() {
      if (recorded) return;
      recorded = true;
      const entry: RecordedWrite = { table, payload, options, filters };
      if (kind === "insert") calls.inserts.push(entry);
      else if (kind === "update") calls.updates.push(entry);
      else if (kind === "upsert") calls.upserts.push(entry);
      else calls.deletes.push(entry);
    }
    function settle(): Promise<{ data: null; error: FakeError | null }> {
      record();
      const handler = writeHandlers.get(`${kind}:${table}`);
      if (handler) {
        // A throwing handler simulates a network-level rejection.
        const error = handler(payload, filters) ?? null;
        return Promise.resolve({ data: null, error });
      }
      return Promise.resolve({ data: null, error: null });
    }
    const builder = {
      eq(col: string, value: unknown) {
        filters.push({ op: "eq", col, value });
        return builder;
      },
      in(col: string, value: unknown) {
        filters.push({ op: "in", col, value });
        return builder;
      },
      is(col: string, value: unknown) {
        filters.push({ op: "is", col, value });
        return builder;
      },
      lt(col: string, value: unknown) {
        filters.push({ op: "lt", col, value });
        return builder;
      },
      gte(col: string, value: unknown) {
        filters.push({ op: "gte", col, value });
        return builder;
      },
      not(col: string, _op: string, value: unknown) {
        filters.push({ op: "not", col, value });
        return builder;
      },
      select() {
        return {
          async single() {
            await settle();
            const first = Array.isArray(payload) ? payload[0] : payload;
            return { data: (first as FakeRow) ?? null, error: null };
          },
          async maybeSingle() {
            await settle();
            const first = Array.isArray(payload) ? payload[0] : payload;
            return { data: (first as FakeRow) ?? null, error: null };
          },
        };
      },
      then<T>(
        resolve: (v: { data: null; error: FakeError | null }) => T,
        reject?: (e: unknown) => T,
      ): Promise<T> {
        return settle().then(resolve, reject);
      },
    };
    return builder;
  }

  const supabaseAdmin = {
    from(table: string) {
      return {
        select: (columns?: string, options?: unknown) => makeSelectBuilder(table, columns, options),
        insert: (payload: unknown) => makeWriteBuilder("insert", table, payload),
        update: (payload: unknown) => makeWriteBuilder("update", table, payload),
        upsert: (payload: unknown, options?: unknown) =>
          makeWriteBuilder("upsert", table, payload, options),
        delete: () => makeWriteBuilder("delete", table, null),
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
  };

  return {
    supabaseAdmin,
    calls,
    seed,
    reset,
    onRpc,
    onInsert,
    onUpdate,
    onUpsert,
    onDelete,
  };
}
