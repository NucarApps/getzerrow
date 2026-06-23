import js from "@eslint/js";
import eslintPluginPrettier from "eslint-plugin-prettier/recommended";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

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
  eslintPluginPrettier,
);
