// Schema-consistency guard (runs in CI, no database connection required).
//
// Reconstructs the final `folder_examples` column set by replaying every
// migration in order (CREATE TABLE + ADD COLUMN + DROP COLUMN), then parses
// the latest `insert_folder_example_encrypted` definition and asserts that
// every column it writes actually exists on the table.
//
// This is the automated backstop for the incident where the RPC still
// referenced the dropped `subject` / `snippet` columns and every write failed
// with Postgres error 42703 (column does not exist). A column mismatch now
// fails the build before it can reach production.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "..", "supabase", "migrations");

/** Migration file contents, sorted by filename (timestamp-prefixed => chronological). */
function loadMigrations(): { name: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(MIGRATIONS_DIR, name), "utf8") }));
}

const CONSTRAINT_KEYWORDS = new Set([
  "unique",
  "primary",
  "foreign",
  "constraint",
  "check",
  "references",
  "exclude",
]);

/** Column names declared in a `CREATE TABLE (...)` body, skipping table constraints. */
function parseCreateTableColumns(body: string): string[] {
  const cols: string[] = [];
  let depth = 0;
  let current = "";
  // Split top-level commas only (parenthesised type args / constraints stay intact).
  for (const ch of body) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      cols.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) cols.push(current);

  const result: string[] = [];
  for (const raw of cols) {
    const first = raw.trim().split(/\s+/)[0]?.replace(/"/g, "").toLowerCase();
    if (!first) continue;
    if (CONSTRAINT_KEYWORDS.has(first)) continue;
    result.push(first);
  }
  return result;
}

/**
 * Replay all migrations to compute the live column set for a public table.
 * Handles `CREATE TABLE [IF NOT EXISTS]`, `ADD COLUMN [IF NOT EXISTS]`, and
 * `DROP COLUMN [IF EXISTS]` (including multiple clauses in one ALTER).
 */
function resolveTableColumns(migrations: { sql: string }[], table: string): Set<string> {
  const columns = new Set<string>();
  const createRe = new RegExp(
    `CREATE TABLE (?:IF NOT EXISTS )?public\\.${table}\\s*\\(([\\s\\S]*?)\\);`,
    "gi",
  );
  const alterRe = new RegExp(`ALTER TABLE (?:ONLY )?public\\.${table}\\s+([\\s\\S]*?);`, "gi");

  for (const { sql } of migrations) {
    let m: RegExpExecArray | null;

    createRe.lastIndex = 0;
    while ((m = createRe.exec(sql))) {
      for (const c of parseCreateTableColumns(m[1])) columns.add(c);
    }

    alterRe.lastIndex = 0;
    while ((m = alterRe.exec(sql))) {
      const clause = m[1];
      let a: RegExpExecArray | null;
      const addRe = /ADD COLUMN\s+(?:IF NOT EXISTS\s+)?"?([a-z_][a-z0-9_]*)"?/gi;
      while ((a = addRe.exec(clause))) columns.add(a[1].toLowerCase());
      const dropRe = /DROP COLUMN\s+(?:IF EXISTS\s+)?"?([a-z_][a-z0-9_]*)"?/gi;
      while ((a = dropRe.exec(clause))) columns.delete(a[1].toLowerCase());
    }
  }
  return columns;
}

/** Body of the LAST definition of a function (later migrations override earlier ones). */
function resolveLatestFunctionBody(migrations: { sql: string }[], fnName: string): string | null {
  // Match the function up to its dollar-quoted body, capturing the tag so we
  // can find the matching close ($$ ... $$ or $function$ ... $function$).
  const headRe = new RegExp(
    `CREATE OR REPLACE FUNCTION public\\.${fnName}\\b[\\s\\S]*?AS \\$([a-zA-Z_]*)\\$`,
    "gi",
  );
  let body: string | null = null;
  for (const { sql } of migrations) {
    let h: RegExpExecArray | null;
    headRe.lastIndex = 0;
    while ((h = headRe.exec(sql))) {
      const tag = h[1];
      const close = sql.indexOf(`$${tag}$`, headRe.lastIndex);
      if (close === -1) continue;
      body = sql.slice(headRe.lastIndex, close);
    }
  }
  return body;
}

/** Columns targeted by the INSERT column list inside a function body. */
function parseInsertColumns(body: string, table: string): string[] {
  const re = new RegExp(`INSERT INTO public\\.${table}\\s*\\(([\\s\\S]*?)\\)\\s*VALUES`, "i");
  const m = body.match(re);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((c) => c.trim().replace(/"/g, "").toLowerCase())
    .filter(Boolean);
}

/** Columns assigned in an `ON CONFLICT ... DO UPDATE SET a = ..., b = ...` clause. */
function parseOnConflictSetColumns(body: string): string[] {
  const m = body.match(/ON CONFLICT[\s\S]*?DO UPDATE SET\s+([\s\S]*?)(?:RETURNING|WHERE|;|$)/i);
  if (!m) return [];
  const cols: string[] = [];
  for (const assignment of m[1].split(",")) {
    const left = assignment.split("=")[0]?.trim().replace(/"/g, "").toLowerCase();
    if (left && /^[a-z_][a-z0-9_]*$/.test(left)) cols.push(left);
  }
  return cols;
}

describe("folder_examples schema vs insert_folder_example_encrypted RPC", () => {
  const migrations = loadMigrations();

  it("has migration files to inspect", () => {
    expect(migrations.length).toBeGreaterThan(0);
  });

  const columns = resolveTableColumns(migrations, "folder_examples");

  it("reconstructs the encrypted columns and drops the legacy plaintext ones", () => {
    // Sanity check the replay itself, so a broken parser can't hide a real bug.
    expect(columns.has("subject_enc")).toBe(true);
    expect(columns.has("snippet_enc")).toBe(true);
    expect(columns.has("subject")).toBe(false);
    expect(columns.has("snippet")).toBe(false);
  });

  const body = resolveLatestFunctionBody(migrations, "insert_folder_example_encrypted");

  it("finds the latest RPC definition", () => {
    expect(body, "insert_folder_example_encrypted definition not found in migrations").toBeTruthy();
  });

  it("only writes columns that exist on folder_examples", () => {
    const written = [
      ...parseInsertColumns(body!, "folder_examples"),
      ...parseOnConflictSetColumns(body!),
    ];
    expect(written.length).toBeGreaterThan(0);

    const missing = written.filter((c) => !columns.has(c));
    expect(
      missing,
      `RPC writes column(s) that no longer exist on folder_examples: ${missing.join(", ")}. ` +
        `Live columns: ${[...columns].sort().join(", ")}`,
    ).toEqual([]);
  });
});
