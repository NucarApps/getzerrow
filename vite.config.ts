// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, cloudflare (build-only),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... } }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

// Public backend connection values. These are the client-safe publishable
// credentials (anon key + project URL), NOT secrets — they are already shipped
// to the browser. We inline them as build-time fallbacks so the published
// Cloudflare Worker can always resolve the Supabase config during SSR, even if
// the managed publish environment fails to inject the variables at build time.
// The service-role key is NEVER included here.
const PUBLIC_SUPABASE_URL = "https://axilcinlnaujxyksfjin.supabase.co";
const PUBLIC_SUPABASE_PUBLISHABLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF4aWxjaW5sbmF1anh5a3NmamluIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyMDUwMDYsImV4cCI6MjA5NDc4MTAwNn0.G_LCsns9WKBptWkWdjDzDx7jzcXGBK0R8Pa_ESs7sZ4";

const supabaseUrl =
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || PUBLIC_SUPABASE_URL;
const supabasePublishableKey =
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  PUBLIC_SUPABASE_PUBLISHABLE_KEY;

// Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
// @cloudflare/vite-plugin builds from this — wrangler.jsonc main alone is insufficient.
export default defineConfig({
  tanstackStart: {
    server: { entry: "server" },
  },
  vite: {
    define: {
      // Build-time fallbacks. Vite's managed env injection still takes priority
      // wherever the managed values are present; these literals only fill gaps
      // so the published runtime never ends up with an empty Supabase config.
      //
      // We define BOTH the non-prefixed server names (read by the generated
      // server-side clients via `process.env.*`) AND the public `VITE_`-prefixed
      // names (read by the generated browser client via `import.meta.env.VITE_*`).
      // The published browser bundle has no `process.env`, so the `import.meta.env`
      // fallbacks are what keep the client from throwing "Missing Supabase
      // environment variable(s)" when the managed injection doesn't reach a chunk.
      "process.env.SUPABASE_URL": JSON.stringify(supabaseUrl),
      "process.env.SUPABASE_PUBLISHABLE_KEY": JSON.stringify(supabasePublishableKey),
      "import.meta.env.VITE_SUPABASE_URL": JSON.stringify(supabaseUrl),
      "import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY": JSON.stringify(supabasePublishableKey),
    },
  },
});
