# Fix the publish error: missing Supabase environment variables

## What's happening

When you publish, the build is throwing:

```text
Missing Supabase environment variable(s): SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY.
```

This comes from the auto-generated backend connection file, which expects the
backend URL and public key to be injected at build time. The error only fires
when **both** the build-time values **and** the server-side fallback values are
missing at once.

## What I verified

- Your project's local environment file already has all four required values
  set correctly (browser + server variants).
- The hosted backend (Lovable Cloud) is healthy and responding normally.
- Your recent changes (the calendar-guard classifier work, folder editor, types)
  do **not** touch backend connection or environment wiring.

Conclusion: this is **not a code bug**. The published build was produced without
the managed backend values being injected — a stale/broken build-environment
state, not something in your source. Since it "worked before and just broke,"
the previous publish picked up the values and this one didn't.

## Plan (recovery, no code changes)

```text
1. Refresh the backend connection so the managed environment values
   are regenerated for the build.
2. Confirm the live preview still loads (it pulls the same values).
3. Republish from the now-healthy preview.
4. If it still fails, fall back to restoring the last known-good
   published version, then republish.
```

### Step 1 — Refresh the managed backend connection
Open Lovable Cloud and reconnect/refresh the backend integration. This
regenerates the managed environment values that the publish build reads.

### Step 2 — Confirm the preview is healthy
Reload the preview and confirm it loads without the "Missing Supabase
environment variable(s)" message. The preview uses the same managed values, so a
healthy preview is the signal the publish build will also succeed.

### Step 3 — Republish
Once the preview is clean, publish again. The build should now inject the values
and complete.

### Step 4 — Fallback if it persists
If publishing still fails after refreshing:
- Restore the last known-good published version from History, then republish, and
- I can add a small safety guard so a missing value at build time degrades more
  gracefully instead of hard-crashing the whole publish (optional hardening).

## Technical notes

- The connection file reads `import.meta.env.VITE_SUPABASE_URL` /
  `VITE_SUPABASE_PUBLISHABLE_KEY` (inlined at build) with a
  `process.env.SUPABASE_URL` / `SUPABASE_PUBLISHABLE_KEY` SSR fallback.
- All four are present in the project env file today, so the failure was in the
  publish build's access to the managed values, not the source.
- No source edits are part of this plan unless Step 4's optional hardening is
  requested.

<presentation-actions>
<presentation-open-publish>Publish your app</presentation-open-publish>
</presentation-actions>
