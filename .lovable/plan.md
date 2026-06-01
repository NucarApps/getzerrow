## Plan

1. **Add a server runtime env bridge**
   - Update `src/server.ts` so the published server runtime copies Lovable Cloud-provided environment bindings into `process.env` before the TanStack server entry is imported.
   - Include the backend variables used by the generated integration code: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and related project/key aliases if present.
   - Do not log or hardcode any secret values.

2. **Leave generated backend integration files untouched**
   - Do not edit `src/integrations/supabase/client.ts`, `client.server.ts`, `auth-middleware.ts`, or `.env`.
   - This keeps the managed Lovable Cloud integration intact and avoids fighting generated files.

3. **Verify the runtime path**
   - Confirm the preview no longer hits the missing environment-variable error.
   - Check the relevant server/client logs for that exact error string.

4. **Republish**
   - Once preview is healthy, publish again. This change is designed specifically for the case where preview/source env exists but the published Worker runtime was not exposing it through `process.env`.