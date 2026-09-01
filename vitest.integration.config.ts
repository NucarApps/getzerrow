import { defineConfig } from "vitest/config";
import { resolve } from "path";

// Match production (Cloudflare Workers) timezone; see vitest.config.ts.
process.env.TZ = "UTC";

export default defineConfig({
  resolve: { alias: { "@": resolve(__dirname, "src") } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./src/test-setup.ts"],
    testTimeout: 30_000,
  },
});
