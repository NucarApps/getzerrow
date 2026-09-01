import { defineConfig } from "vitest/config";
import { resolve } from "path";

// DB-backed integration suites (tests/*.integration.test.ts). They need a
// migrated Postgres at TEST_DATABASE_URL and skip themselves without it.
// Live-HTTP smokes against a deployment live in vitest.live.config.ts.
//
// Match production (Cloudflare Workers) timezone; see vitest.config.ts.
process.env.TZ = "UTC";

export default defineConfig({
  resolve: { alias: { "@": resolve(__dirname, "src") } },
  test: {
    environment: "node",
    include: ["tests/**/*.integration.test.ts"],
    setupFiles: ["./src/test-setup.ts"],
    testTimeout: 30_000,
  },
});
