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
          // A test that needs longer than this is waiting on a real timer
          // or real I/O — fake it instead (see push.server.test.ts).
          testTimeout: 5_000,
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
          testTimeout: 5_000,
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/**/__fixtures__/**",
        "src/test-setup.ts",
        "src/test-setup.dom.ts",
        "src/integrations/supabase/types.ts",
        "src/routeTree.gen.ts",
        // Easter-egg game; no product logic.
        "src/lib/invader/**",
      ],
      reporter: ["text-summary", "json-summary", "html"],
      // Ratchet floors. Every glob is measured on its own so the server
      // code's floor cannot be diluted by (or hide) the UI's. Raise a floor
      // as its area grows — never lower one to make a PR pass.
      //
      // Baselines when each floor was set (Sep 2026, after the server-fn
      // sweep): lib 73.9% lines / 71.4% stmts / 72.1% fns / 61.2% br;
      // routes/api 15.6 / 17.4 / 40.3 / 9.3 (the auth sweeps and route
      // tests move it); components+hooks 5.1 / 5.4 / 6.0 / 3.5 (the jsdom
      // *.test.tsx project moves it).
      //
      // Component logic is being pulled into src/lib/ui as it gets tested,
      // so the components floor tracks what is left behind — rendering —
      // rather than growing indefinitely.
      // Page routes (src/routes outside api/) are measured but have no floor
      // yet: their logic is being extracted into src/lib first.
      thresholds: {
        "src/lib/**": {
          statements: 88,
          branches: 76,
          functions: 90,
          lines: 90,
        },
        "src/routes/api/**": {
          statements: 93,
          branches: 80,
          functions: 96,
          lines: 93,
        },
        "src/{components,hooks}/**": {
          statements: 37,
          branches: 28,
          functions: 32,
          lines: 37,
        },
      },
    },
  },
});
