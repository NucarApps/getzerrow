# Atzro rebrand + rules engine rethink

Two workstreams. The rebrand is mechanical and ships first. The rules engine starts with an audit so we choose the rebuild from evidence, not guesses.

## Workstream 1 — Rebrand to Atzro

Full rebrand including internals, as chosen.

Visual direction: keep the dark deep-space UI, swap the NASA-orange accent for the Atzro violet-to-coral gradient.

- Palette: base `#0a0e1a`, surfaces `#131826`, primary violet `#8b5cf6`, secondary/glow coral `#fb7185`. Gradient token `violet -> pink -> coral` for the primary CTA, active nav, focus ring, and progress/rocket indicators.
- Logo: the uploaded mark and lockup become CDN assets; mark for the sidebar/mobile, lockup for login, landing, and the public contact card.
- Favicon: square copy of the mark in `public/`, replacing the current Zerrow icons.
- Copy: every visible "Zerrow" becomes "Atzro" — landing page, login, privacy, terms, guides, empty states, digest emails, contact-card OG images, `llms.txt`, `robots.txt`, `manifest.webmanifest`, page titles and meta/OG on every route.
- Wake word: "Hey Zerrow" becomes "Hey Atzro" in the meeting Q&A trigger, with the old phrase kept as a silent alias so in-flight meetings don't break.
- Internals: rename identifiers, comments, test fixtures, and asset filenames. Database table/column names, env var names, and existing OAuth/webhook secret names stay untouched — renaming those is a live-data migration with no user benefit.

Out of scope: the `getzerrow.com` domain and Google OAuth consent-screen branding. Both are configured outside the codebase; I will list the exact steps for you at the end.

## Workstream 2 — Rules engine

### Phase A — Audit (first deliverable)

The pipeline has grown many independent paths that can file a message: the filter engine, AI classification, the Gmail-label mirror, ingest/backfill, rescue, reprocess, and manual moves. Each has its own copy of the precedence order. I will map all of them and produce a findings document covering:

- Every code path that can set an email's folder, and the order it applies.
- Where those orders disagree (the concrete "confusing" bugs).
- Where a decision is made but not recorded, so the UI can't explain it.
- Which folder settings silently interact (priority, `filter_logic`, exclusions, `skip_ai`, min confidence, surface-to-inbox, cold-email guard, pause).

You review that document and we pick the rebuild scope from it.

### Phase B — The target model (what I expect to build)

Based on your description, the intended engine is a single ordered pipeline, evaluated once per message, with no other path allowed to file mail:

```text
1. Gmail label mirror   folder linked to a label Gmail already applied -> file, stop
2. Hard rules           deterministic conditions, folder priority order -> file, stop
3. Exclusions/vetoes    any matching exclusion pins the message to the inbox -> stop
4. AI fallback          only when no hard rule matched:
                        score the message against every eligible folder's
                        description + learned profile, pick the best above
                        that folder's confidence floor -> file
5. Inbox                nothing matched -> stays in the inbox
```

Key changes from today:

- Hard rules always beat AI. AI never re-files something a rule already decided.
- AI matches against a plain-language **folder description** you write, so folder setup is "describe what belongs here" instead of assembling a rule tree.
- One evaluation per message, one recorded outcome. Backfill, rescue, and reprocess call the same function instead of reimplementing it.

### Phase C — Full decision trace

Every filed message stores a structured trace, and the AI decision drawer shows it in plain language:

- Stage that decided it (label mirror / hard rule / exclusion / AI / none).
- For a rule: which folder, which condition, the field, operator, and the value it matched, and which rules were evaluated and skipped before it.
- For AI: the folder descriptions it compared, the score per candidate folder, the winner, its confidence, the folder's floor, and the model's stated reason.
- Side effects applied (archive, mark-read, star, hide, forward, snooze) or the reason they were skipped (folder paused).

Traces are written for backfill and reprocess too, so you can replay why anything landed where it did.

### Phase D — Simulator and rollout

- "Test this folder" runs the new engine against your recent mail and shows what would change, before anything moves.
- The new engine ships behind a per-account switch so we can compare old and new on real mail, then flip it on.

## Technical notes

- New `src/lib/rules/` module: a pure `evaluate(message, folders, rules)` returning `{ folderId, stage, trace }` with no Supabase imports, so the whole precedence is unit-testable. Existing `src/lib/sync/filter-engine.ts` logic folds into it.
- `folders` gains a `description` column (the AI-facing plain-language rule) and `emails` gains a `decision_trace` jsonb column; existing `ai_rule` / `learned_profile` are migrated into the new fields.
- Design tokens change in `src/styles.css` and `public/zerrow-landing.css` (renamed); no component hardcodes colors, so the accent swap is token-only.
- Logos go through Lovable Assets; the favicon is a real square file in `public/`.

## Order of work

1. Rebrand (visible immediately).
2. Rules engine audit document — you review before I write engine code.
3. New engine + trace + simulator, behind a switch.
