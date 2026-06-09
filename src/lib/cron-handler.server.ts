// Boilerplate killer for /api/public/* cron endpoints.
//
// Every cron endpoint had the same shape:
//   POST: async ({ request }) => {
//     if (!(await isAuthorizedCronRequest(request))) return unauthorizedResponse();
//     try {
//       const r = await <doStuff>;
//       return Response.json({ ok: true, ...r });
//     } catch (e) {
//       console.error("<name> failed", e);
//       return Response.json({ ok: false, error: "..." }, { status: 500 });
//     }
//   }
//
// Wrap the actual handler with `cronHandler(opName, fn)` and the
// auth + try/catch + JSON-response + structured-log boilerplate
// disappears. The handler returns its result object; the wrapper
// adds `ok: true` on success and `ok: false, error` on failure.
//
// Errors are caught + logged with structured context (op = the
// passed-in name) + responded as JSON { ok: false, error } with
// HTTP 500. Auth failures respond with 401 and no body details.
import { isAuthorizedCronRequest, unauthorizedResponse } from "./cron-auth.server";
import { log } from "./log.server";

export type CronHandlerArgs = {
  request: Request;
  url: URL;
};

/** Wrap a cron-endpoint handler. The wrapper handles auth + try/catch
 * + Response.json + structured logging. Your `fn` just returns the
 * result object (or throws on errors). */
export function cronHandler<T extends object>(
  opName: string,
  fn: (args: CronHandlerArgs) => Promise<T>,
): (ctx: { request: Request }) => Promise<Response> {
  return async ({ request }) => {
    if (!(await isAuthorizedCronRequest(request))) return unauthorizedResponse();
    const url = new URL(request.url);
    try {
      const r = await fn({ request, url });
      return Response.json({ ok: true, ...r });
    } catch (e: unknown) {
      const msg = (e as Error)?.message ?? String(e);
      log.error({ op: opName, err: e }, `cron endpoint failed: ${opName}`);
      return Response.json({ ok: false, error: msg.slice(0, 500) }, { status: 500 });
    }
  };
}

/** Helper for the very common pattern of "clamp a query-string int to
 * a [min, max] range with a fallback." */
export function clampIntParam(url: URL, key: string, min: number, max: number, fallback: number): number {
  const raw = url.searchParams.get(key);
  if (raw == null) return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/** Optional integer param — returns undefined if absent or invalid. */
export function optionalIntParam(url: URL, key: string, min: number, max: number): number | undefined {
  const raw = url.searchParams.get(key);
  if (raw == null || raw === "") return undefined;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(min, Math.min(max, n));
}
