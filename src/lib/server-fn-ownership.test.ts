// Every server fn that takes a client-supplied id and runs on the
// SERVICE-ROLE client must carry an ownership guard.
//
// This is the property that stops a signed-in user reading or writing
// another tenant's row by passing its id. Two mechanisms enforce it in
// this codebase:
//
//   1. RLS, when the handler works through `context.supabase` (the
//      user-scoped client). Unit tests cannot prove RLS — that lives in
//      the DB-backed suite — so those handlers are out of scope here.
//   2. An app-level guard, when the handler reaches for `supabaseAdmin`,
//      which bypasses RLS entirely. THAT is what this sweeps: an
//      `assertOwns*` call, one of the `getOwned*` / `getEmailAccount`
//      helpers (each throws on a foreign row — see
//      gmail-helpers.server.test.ts), a `user_id` predicate on the query,
//      or an explicit comparison in the handler.
//
// It is a static sweep rather than a per-fn test because there are ~270
// server fns and the property is checkable by reading them. A per-fn
// cross-tenant test is still the better evidence where one exists
// (`expectDeniedCrossUser`); this is the floor underneath, and its real
// job is that a NEW server fn cannot land without either a guard or a
// deliberate, reasoned exemption.
//
// It reports file and fn name for anything it cannot see a guard in.
// If it flags something that IS guarded by a helper it does not know,
// add the helper to GUARD_PATTERNS — after checking the helper actually
// throws.
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(): string[] {
  return (readdirSync(SRC, { recursive: true }) as string[])
    .map((p) => p.split(path.sep).join("/"))
    .filter((rel) => rel.endsWith(".ts") && !rel.endsWith(".test.ts"))
    .filter((rel) => !rel.includes("__fixtures__/"))
    .sort();
}

export type ServerFn = {
  name: string;
  /** Everything before `.handler(` — the middleware and validator chain. */
  chain: string;
  /** Everything from `.handler(` to the end of the declaration. */
  handler: string;
};

/** Split a module into its `export const X = createServerFn(...)` blocks.
 * A declaration runs to the next top-level `export`, or end of file. */
export function serverFns(source: string): ServerFn[] {
  const out: ServerFn[] = [];
  const re = /export const (\w+)\s*=\s*createServerFn\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const nextRe = /\nexport (?:const|function|type|async function) /g;
    nextRe.lastIndex = m.index + 10;
    const next = nextRe.exec(source);
    const body = source.slice(m.index, next ? next.index : source.length);
    const split = body.indexOf(".handler(");
    out.push({
      name: m[1]!,
      chain: split < 0 ? body : body.slice(0, split),
      handler: split < 0 ? "" : body.slice(split),
    });
  }
  return out;
}

/** Does the validator accept an id-shaped field from the client? */
export function takesClientId(chain: string): boolean {
  return /\b\w*[Ii]d\s*:\s*z\.string\(\)/.test(chain);
}

/** Does the handler reach past RLS? */
export function usesServiceRole(handler: string): boolean {
  return /\bsupabaseAdmin\b/.test(handler);
}

/** Ways this codebase establishes ownership. Each helper named here was
 * checked to throw on a foreign row. */
const GUARD_PATTERNS: Array<{ why: string; re: RegExp }> = [
  { why: "assertOwns* helper", re: /assertOwns\w+\(/ },
  {
    why: "getOwned*/getEmailAccount helper (throws on a foreign row)",
    re: /\b(getOwnedAccount|getOwnedFolder|getOwnedSchedule|getEmailAccount)\(/,
  },
  { why: "user_id predicate on the query", re: /\.eq\(\s*["']user_id["']/ },
  {
    why: "user_id written from the authenticated context",
    re: /user_id:\s*(userId|context\.userId)/,
  },
  { why: "p_user_id passed to a SECURITY DEFINER rpc", re: /p_user_id:/ },
  { why: "explicit comparison in the handler", re: /\.user_id\s*!==\s*(userId|context\.userId)/ },
  { why: "runs on the RLS client", re: /context\.supabase|\{\s*supabase[\s,}]/ },
];

export function guardOf(handler: string): string | null {
  for (const g of GUARD_PATTERNS) if (g.re.test(handler)) return g.why;
  return null;
}

/** Deliberate exemptions. Empty by design — every entry needs a reason
 * that survives someone asking "why is this one allowed to skip it?". */
const EXEMPT = new Map<string, string>([]);

const FILES = sourceFiles();

type Exposed = { rel: string; name: string; guard: string | null };

const exposed: Exposed[] = [];
let totalFns = 0;
for (const rel of FILES) {
  const source = readFileSync(path.join(SRC, rel), "utf8");
  if (!source.includes("createServerFn")) continue;
  for (const fn of serverFns(source)) {
    totalFns++;
    if (!takesClientId(fn.chain)) continue;
    if (!usesServiceRole(fn.handler)) continue;
    exposed.push({ rel, name: fn.name, guard: guardOf(fn.handler) });
  }
}

describe("server fns on the service-role client are ownership-guarded", () => {
  it("found the server fns to sweep", () => {
    // A parser that quietly stopped matching would pass this file while
    // checking nothing.
    expect(totalFns).toBeGreaterThan(200);
    expect(exposed.length).toBeGreaterThan(20);
  });

  it("every one carries a recognised guard", () => {
    const unguarded = exposed
      .filter((e) => !e.guard && !EXEMPT.has(`${e.rel}:${e.name}`))
      .map((e) => `${e.rel}  ${e.name}`);

    expect(
      unguarded,
      "these run on supabaseAdmin (which bypasses RLS) with a client-supplied id " +
        "and no visible ownership check. Add assertOwns*/getOwned*, a user_id " +
        "predicate, or move the handler onto context.supabase:\n" +
        unguarded.join("\n"),
    ).toEqual([]);
  });

  it("every exemption still names a fn that exists", () => {
    for (const key of EXEMPT.keys()) {
      const [rel, name] = key.split(":");
      expect(
        exposed.some((e) => e.rel === rel && e.name === name),
        `${key} is exempted but no longer matches a swept server fn`,
      ).toBe(true);
    }
  });
});

describe("the sweep's own reading of a module", () => {
  const decl = (name: string, chain: string, handler: string) =>
    `export const ${name} = createServerFn({ method: "POST" })\n${chain}\n.handler(${handler});\n`;

  it("splits a module into one entry per server fn", () => {
    const source = decl("a", "", "async () => {}") + decl("b", "", "async () => {}");
    expect(serverFns(source).map((f) => f.name)).toEqual(["a", "b"]);
  });

  it("does not let one fn's handler bleed into the next declaration", () => {
    const source =
      decl(
        "guarded",
        ".validator((d) => z.object({ id: z.string().uuid() }).parse(d))",
        "async ({ data, context }) => { await assertOwnsContact(context.userId, data.id); }",
      ) + decl("plain", "", "async () => { await supabaseAdmin.from('x').select('*'); }");
    const [first, second] = serverFns(source);
    expect(guardOf(first!.handler)).toBeTruthy();
    expect(guardOf(second!.handler)).toBeNull();
  });

  it("sees an id in the validator, and nothing in one without", () => {
    expect(takesClientId(".validator((d) => z.object({ id: z.string().uuid() }).parse(d))")).toBe(
      true,
    );
    expect(takesClientId(".validator((d) => z.object({ folder_id: z.string() }).parse(d))")).toBe(
      true,
    );
    expect(takesClientId(".validator((d) => z.object({ query: z.string() }).parse(d))")).toBe(
      false,
    );
  });

  it("only considers a handler that actually reaches for supabaseAdmin", () => {
    expect(usesServiceRole("async () => { await supabaseAdmin.from('x'); }")).toBe(true);
    expect(usesServiceRole("async ({ context }) => { await context.supabase.from('x'); }")).toBe(
      false,
    );
  });

  it("recognises each way ownership is established here", () => {
    const cases = [
      "await assertOwnsContact(userId, data.id);",
      "await getOwnedFolder(context.userId, data.folder_id);",
      'await supabaseAdmin.from("x").select("*").eq("user_id", userId);',
      'await supabaseAdmin.from("x").insert({ user_id: userId });',
      'await supabaseAdmin.rpc("f", { p_user_id: userId });',
      "if (row.user_id !== userId) throw new Error();",
      "const { supabase, userId } = context;",
    ];
    for (const c of cases) expect(guardOf(c), c).toBeTruthy();
  });

  it("does not mistake an unrelated user_id mention for a guard", () => {
    expect(guardOf('const cols = "id, user_id, name";')).toBeNull();
    expect(guardOf("return rows.map((r) => r.user_id);")).toBeNull();
  });
});
