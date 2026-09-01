import js from "@eslint/js";
import eslintPluginPrettier from "eslint-plugin-prettier/recommended";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import vitest from "@vitest/eslint-plugin";

export default tseslint.config(
  { ignores: ["dist", ".output", ".vinxi"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "server-only",
              message:
                "TanStack Start does not use the Next.js `server-only` package. Rename the module to `*.server.ts` or mark it with `@tanstack/react-start/server-only`.",
            },
          ],
        },
      ],
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": "off",
      // The React Compiler-era react-hooks rules (refs / purity / immutability /
      // set-state-in-effect) flag patterns pervasively across this pre-existing
      // codebase. Keep rules-of-hooks + exhaustive-deps enforced; adopt the
      // stricter set incrementally rather than block every PR on a large refactor.
      "react-hooks/refs": "off",
      "react-hooks/purity": "off",
      "react-hooks/immutability": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
  {
    // Files that intentionally co-export non-components alongside a component:
    //  - TanStack file-based route modules (export the `Route` object created
    //    by createFileRoute alongside the route component)
    //  - vendored shadcn/ui primitives (cva variant helpers, useFormField)
    //  - context-provider modules co-exporting their use* hook
    //  - the card-theme data module (CARD_THEMES / getTheme + ThemePicker)
    // These are deliberate shared-module patterns; Fast Refresh isn't a concern,
    // so relax the rule here rather than fork conventions or churn every import.
    files: [
      "src/routes/**/*.{ts,tsx}",
      "src/components/ui/**/*.{ts,tsx}",
      "src/lib/account-selection.tsx",
      "src/lib/folder-selection.tsx",
      "src/components/cards/themes.tsx",
    ],
    rules: {
      "react-refresh/only-export-components": "off",
    },
  },
  {
    // Vendored shadcn/ui primitives carry a few upstream `any`s (chart tooltip
    // payloads, sidebar context). Don't fight upstream types in vendored code.
    files: ["src/components/ui/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    // Test-only rules. The assertion helpers in __fixtures__ count as
    // assertions for expect-expect; direct process.env mutation is banned
    // in favour of vi.stubEnv (the global teardown only unstubs).
    files: ["src/**/*.test.{ts,tsx}", "tests/**/*.ts", "src/**/__fixtures__/**/*.ts"],
    plugins: { vitest },
    rules: {
      ...vitest.configs.recommended.rules,
      "vitest/no-focused-tests": "error",
      "vitest/no-disabled-tests": "warn",
      "vitest/expect-expect": [
        "error",
        {
          assertFunctionNames: ["expect", "expect*", "assert*"],
        },
      ],
      // `if (r?.kind === "match") expect(r.folder_id)…` after asserting the
      // kind is the idiomatic TS-narrowing shape here, not a hidden branch.
      "vitest/no-conditional-expect": "off",
      // vitest's expect(actual, message) form is used throughout.
      "vitest/valid-expect": ["error", { maxArgs: 2 }],
      "vitest/no-standalone-expect": "error",
      "vitest/valid-title": "error",
      "vitest/no-identical-title": "error",
      "vitest/no-import-node-test": "error",
      "vitest/prefer-hooks-in-order": "warn",
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "AssignmentExpression[left.type='MemberExpression'][left.object.type='MemberExpression'][left.object.object.name='process'][left.object.property.name='env']",
          message: "Use vi.stubEnv(name, value) — the global teardown only restores stubbed env.",
        },
        {
          selector:
            "UnaryExpression[operator='delete'][argument.object.type='MemberExpression'][argument.object.object.name='process'][argument.object.property.name='env']",
          message: "Use vi.stubEnv(name, undefined) instead of delete process.env.X.",
        },
      ],
    },
  },
  eslintPluginPrettier,
);
