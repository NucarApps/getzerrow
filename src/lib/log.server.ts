// Tiny structured-logging shim. Replaces scattered `console.error("...",
// err)` calls with `log.error({ op, accountId }, "message")` so log
// aggregators (Cloudflare logs, Sentry, Datadog) can index by field
// instead of regex-parsing strings.
//
// Stays vendor-neutral by writing JSON lines to console. Switch to a
// real logger (pino, winston) later by replacing the implementation
// here; call sites won't change.
//
// USAGE
//   import { log } from "@/lib/log.server";
//   log.error({ accountId, op: "syncSinceHistory" }, "history sync failed");
//   log.warn({ messageId }, "rpc not deployed; using fallback");
//   log.info({ deleted: 42 }, "retention pass complete");

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogContext = {
  // Common fields. Add more as needed — extra keys are passed through.
  op?: string;                  // 'syncSinceHistory', 'rpc:claim_message_jobs', ...
  accountId?: string | null;
  userId?: string | null;
  emailId?: string | null;
  jobId?: string | null;
  msgId?: string | null;        // gmail_message_id
  err?: unknown;                // exception object — formatted below
  [key: string]: unknown;
};

function formatErr(err: unknown): { message: string; stack?: string } | string {
  if (err == null) return String(err);
  if (err instanceof Error) {
    return { message: err.message, stack: err.stack };
  }
  if (typeof err === "string") return err;
  try { return JSON.stringify(err); } catch { return String(err); }
}

function emit(level: LogLevel, ctx: LogContext | undefined, msg: string) {
  const payload: Record<string, unknown> = {
    level,
    msg,
    ts: new Date().toISOString(),
  };
  if (ctx) {
    for (const [k, v] of Object.entries(ctx)) {
      if (v === undefined) continue;
      if (k === "err") payload.err = formatErr(v);
      else payload[k] = v;
    }
  }
  // Use the appropriate console method so log aggregators that filter
  // by stream (stdout vs stderr) get the right routing.
  const line = JSON.stringify(payload);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (ctx: LogContext | string, msg?: string) => {
    if (typeof ctx === "string") emit("debug", undefined, ctx);
    else emit("debug", ctx, msg ?? "");
  },
  info: (ctx: LogContext | string, msg?: string) => {
    if (typeof ctx === "string") emit("info", undefined, ctx);
    else emit("info", ctx, msg ?? "");
  },
  warn: (ctx: LogContext | string, msg?: string) => {
    if (typeof ctx === "string") emit("warn", undefined, ctx);
    else emit("warn", ctx, msg ?? "");
  },
  error: (ctx: LogContext | string, msg?: string) => {
    if (typeof ctx === "string") emit("error", undefined, ctx);
    else emit("error", ctx, msg ?? "");
  },
};
