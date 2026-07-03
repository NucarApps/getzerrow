// Regression test for the folder-learning write path.
//
// Background: `insert_folder_example_encrypted` once still referenced the
// dropped plaintext `subject` / `snippet` columns, so every call failed with
// Postgres 42703 (column does not exist) and folder learning silently stopped
// growing. `src/lib/folder-examples-schema.test.ts` guards the migration text
// statically; THIS test proves the deployed function actually EXECUTES and
// writes through the encrypted columns only.
//
// It runs the real RPC against a real database, then asserts:
//   1. the call succeeds (no 42703),
//   2. it writes subject_enc / snippet_enc (round-trips via the decrypt RPC),
//   3. folder_examples exposes ONLY the *_enc columns (no legacy subject/snippet),
//   4. the ON CONFLICT path UPDATES the same row's encrypted columns.
//
// SAFETY:
//   - Skipped unless TEST_DATABASE_URL is set.
//   - Everything runs inside a single transaction that is ALWAYS ROLLED BACK,
//     so it creates no persistent rows — safe against staging.
//   - TEST_DATABASE_URL must have privileges to create fixture rows
//     (a service-role / owner connection string). Do NOT point it at prod.
//
// Run:
//   TEST_DATABASE_URL=postgres://... bun run test:integration
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";

const DB_URL = process.env.TEST_DATABASE_URL;
const enabled = !!DB_URL;
const d = enabled ? describe : describe.skip;

// Deterministic fixture ids so a leaked row (should never happen — we roll
// back) is obvious and easy to purge.
const USER_ID = "aa000000-0000-4000-8000-000000000001";
const ACCOUNT_ID = "bb000000-0000-4000-8000-000000000001";
const FOLDER_ID = "cc000000-0000-4000-8000-000000000001";
const MESSAGE_ID = "regression-folder-example-msg-1";
const ENC_KEY = "regression-test-key";

d("insert_folder_example_encrypted (live RPC regression)", () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: DB_URL });
    await client.connect();
    await client.query("BEGIN");

    // Minimal fixtures to satisfy the FK chain:
    // folder_examples -> folders -> gmail_accounts -> auth.users.
    await client.query(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [
      USER_ID,
      "regression@example.com",
    ]);
    await client.query(
      `INSERT INTO public.gmail_accounts (id, user_id, email_address, token_expires_at)
       VALUES ($1, $2, $3, now() + interval '1 day')`,
      [ACCOUNT_ID, USER_ID, "regression@example.com"],
    );
    await client.query(
      `INSERT INTO public.folders (id, user_id, name, gmail_account_id)
       VALUES ($1, $2, $3, $4)`,
      [FOLDER_ID, USER_ID, "Regression Folder", ACCOUNT_ID],
    );
  });

  afterAll(async () => {
    if (client) {
      // Undo every fixture + example write. Nothing persists.
      await client.query("ROLLBACK").catch(() => {});
      await client.end().catch(() => {});
    }
  });

  async function callRpc(subject: string, snippet: string, source: string) {
    return client.query(
      `SELECT public.insert_folder_example_encrypted(
         $1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::text, $7::text, $8::text, $9::text
       ) AS id`,
      [USER_ID, ACCOUNT_ID, FOLDER_ID, MESSAGE_ID, "from@example.com", subject, snippet, source, ENC_KEY],
    );
  }

  async function decryptedRows() {
    const res = await client.query(
      `SELECT subject, snippet, source
         FROM public.get_folder_examples_decrypted($1::uuid, $2::text)`,
      [FOLDER_ID, ENC_KEY],
    );
    return res.rows as Array<{ subject: string | null; snippet: string | null; source: string }>;
  }

  it("folder_examples exposes only the encrypted subject/snippet columns", async () => {
    const res = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'folder_examples'`,
    );
    const cols = new Set(res.rows.map((r) => r.column_name as string));
    expect(cols.has("subject_enc")).toBe(true);
    expect(cols.has("snippet_enc")).toBe(true);
    // The dropped plaintext columns must be gone — their presence was the bug.
    expect(cols.has("subject")).toBe(false);
    expect(cols.has("snippet")).toBe(false);
  });

  it("INSERT path succeeds and writes through subject_enc / snippet_enc", async () => {
    const res = await callRpc("Subject One", "Snippet One", "seed");
    expect(res.rows[0].id, "RPC returned no id").toBeTruthy();

    const stored = await client.query(
      `SELECT subject_enc, snippet_enc FROM public.folder_examples WHERE folder_id = $1`,
      [FOLDER_ID],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0].subject_enc).not.toBeNull();
    expect(stored.rows[0].snippet_enc).not.toBeNull();

    const rows = await decryptedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].subject).toBe("Subject One");
    expect(rows[0].snippet).toBe("Snippet One");
    expect(rows[0].source).toBe("seed");
  });

  it("ON CONFLICT path UPDATES the same row's encrypted columns", async () => {
    await callRpc("Subject Two", "Snippet Two", "correction");

    const count = await client.query(
      `SELECT count(*)::int AS n FROM public.folder_examples WHERE folder_id = $1`,
      [FOLDER_ID],
    );
    expect(count.rows[0].n, "conflict should update in place, not insert a new row").toBe(1);

    const rows = await decryptedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].subject).toBe("Subject Two");
    expect(rows[0].snippet).toBe("Snippet Two");
    expect(rows[0].source).toBe("correction");
  });
});
