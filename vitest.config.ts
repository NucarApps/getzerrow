import { defineConfig } from "vitest/config";
import { resolve } from "path";

// Tests format dates via toLocaleDateString; production runs on Cloudflare
// Workers (UTC). Pin the suite to UTC so results don't depend on the dev
// machine's timezone. Set here (main process) so worker threads inherit it.
process.env.TZ = "UTC";

export default defineConfig({
  resolve: {
    alias: { "@": resolve(__dirname, "src") },
  },
  test: {
    // Two projects: the node suite (all *.test.ts) and the jsdom component
    // suite (*.test.tsx — previously not even collected by the glob).
    // `bun run test` runs both; `vitest run <file>` still targets one file.
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts"],
          setupFiles: ["./src/test-setup.ts"],
          // restoreAllMocks in the teardown does not wipe module-scope
          // vi.fn() call history; clear it before every test instead of
          // relying on per-file mockClear boilerplate.
          clearMocks: true,
          testTimeout: 20_000,
        },
      },
      {
        extends: true,
        test: {
          name: "ui",
          environment: "jsdom",
          include: ["src/**/*.test.tsx"],
          setupFiles: ["./src/test-setup.ts", "./src/test-setup.dom.ts"],
          clearMocks: true,
          testTimeout: 20_000,
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // Routes and components have no rendering-test harness yet (planned:
      // jsdom + testing-library project); invader is an easter-egg game.
      // Revisit these exclusions when component testing lands.
      exclude: [
        "src/**/*.test.ts",
        "src/**/__fixtures__/**",
        "src/test-setup.ts",
        "src/routes/**",
        "src/components/**",
        "src/lib/invader/**",
        "src/routeTree.gen.ts",
      ],
      reporter: ["text-summary", "json-summary", "html"],
      // Ratchet floor, set ~2 points under the level achieved by the
      // Sep 2026 coverage push (45.8% stmts / 47.3% lines; the pre-push
      // baseline was 39.2% / 40.3%). Raise these as coverage grows —
      // never lower them to make a PR pass.
      thresholds: {
        statements: 43,
        branches: 38,
        functions: 42,
        lines: 45,
      },
    },
  },
});
