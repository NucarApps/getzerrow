// Structured server-side logger for cron + sync code paths.
//
// All errors emit a single JSON line so they're trivially grep-able and
// can be ingested by log aggregators without regex acrobatics. Every
// cron handler is wrapped with `withCronRun` which stamps a per-tick
// `run_id` — pass it through to logError calls so every line from one
// cron invocation correlates.
//
// Shape:
//   {"ts":"2026-05-26T20:53:15.123Z","level":"error","scope":"poll.account",
//    "run_id":"abc123","account_id":"…","duration_ms":1230,
//    "err":{"name":"GmailApiError","message":"…","status":429,"stack":"…"}}

export type LogFields = Record<string, unknown>;

export type ErrorShape = {
  name?: string;
  message: string;
  stack?: string;
  status?: number;
  code?: string | number;
};

const STACK_MAX_LINES = 8;
const STACK_MAX_CHARS = 2000;
const MESSAGE_FALLBACK_MAX = 500;

export function serializeError(err: unknown): ErrorShape {
  if (err instanceof Error) {
    const out: ErrorShape = { name: err.name, message: err.message };
    if (err.stack) {
      out.stack = err.stack.split("\n").slice(0, STACK_MAX_LINES).join("\n").slice(0, STACK_MAX_CHARS);
    }
    const extra = err as unknown as { status?: unknown; code?: unknown };
    if (typeof extra.status === "number") out.status = extra.status;
    if (typeof extra.code === "string" || typeof extra.code === "number") {
      out.code = extra.code as string | number;
    }
    return out;
  }
  if (err && typeof err === "object") {
    const o = err as Record<string, unknown>;
    const message =
      typeof o.message === "string"
        ? o.message
        : JSON.stringify(o).slice(0, MESSAGE_FALLBACK_MAX);
    const shape: ErrorShape = { message };
    if (typeof o.status === "number") shape.status = o.status;
    if (typeof o.code === "string" || typeof o.code === "number") {
      shape.code = o.code as string | number;
    }
    return shape;
  }
  return { message: String(err) };
}

function emit(level: "info" | "error", scope: string, fields: LogFields, err?: unknown): void {
  const payload: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    scope,
    ...fields,
  };
  if (err !== undefined) payload.err = serializeError(err);
  const line = JSON.stringify(payload);
  if (level === "error") console.error(line);
  else console.log(line);
}

export function logError(scope: string, fields: LogFields, err?: unknown): void {
  emit("error", scope, fields, err);
}

export function logInfo(scope: string, fields: LogFields = {}): void {
  emit("info", scope, fields);
}

/**
 * Audit trail for security-relevant lifecycle events that grant, revoke, or
 * delete access to restricted Google user data (OAuth connect/disconnect,
 * account deletion). Emitted as `scope:"audit.<action>"` with `audit:true` so
 * the trail is easy to isolate in a log aggregator.
 *
 * Metadata ONLY — pass ids and counts, never email content, tokens, or other
 * restricted data, so the audit log itself can never become a leak vector.
 */
export function logAudit(action: string, fields: LogFields = {}): void {
  emit("info", `audit.${action}`, { audit: true, ...fields });
}

export function newRunId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID?.() ?? Math.random().toString(36).slice(2, 14);
}

/** Wrap a cron handler body. Logs start, end (with duration_ms + ok),
 * and crashes. Provides a stable run_id to thread through inner logs. */
export async function withCronRun<T>(
  name: string,
  fn: (ctx: { runId: string }) => Promise<T>,
): Promise<T> {
  const runId = newRunId();
  const t0 = Date.now();
  logInfo(`cron.${name}.start`, { run_id: runId });
  try {
    const result = await fn({ runId });
    logInfo(`cron.${name}.end`, {
      run_id: runId,
      duration_ms: Date.now() - t0,
      ok: true,
    });
    return result;
  } catch (e) {
    logError(
      `cron.${name}.crash`,
      { run_id: runId, duration_ms: Date.now() - t0 },
      e,
    );
    throw e;
  }
}
