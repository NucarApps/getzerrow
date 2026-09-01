import { defineConfig } from "vitest/config";
import { resolve } from "path";

// Live-HTTP smokes against a DEPLOYED URL (tests/*.live.test.ts). Each file
// skips itself unless PUBLIC_BASE_URL (and, for the cron flow, CRON_SECRET)
// is set. Distinct from the DB-backed integration lane in
// vitest.integration.config.ts, which needs only a local Postgres.
process.env.TZ = "UTC";

export default defineConfig({
  resolve: { alias: { "@": resolve(__dirname, "src") } },
  test: {
    environment: "node",
    include: ["tests/**/*.live.test.ts"],
    setupFiles: ["./src/test-setup.ts"],
    testTimeout: 30_000,
  },
});
