## Goal

Let users carve exceptions out of folder rules so a single sender can be kept out of a domain-wide folder and pushed back to the inbox — both per folder ("exclude this address from Factory") and globally ("never auto-sort this address into any folder").

## Changes

### 1. New "Exclude" operators on folder rules

`folder_filters` already has `field`, `op`, `value`. Add two new operator values, no schema change:

- `not_contains`
- `not_equals`

Sync engine update (`src/lib/sync.server.ts`, `applyFilter` + `matchByFilters`):

- Extend `applyFilter` switch with `not_contains` / `not_equals`.
- Split each folder's rules into **includes** (any positive op) and **excludes** (`not_*` ops).
- A folder matches when: at least one include hits **AND** no exclude hits.
- If a folder's include would have hit but an exclude blocked it, mark the email so the **AI classifier is skipped** and the email stays in the inbox (unsorted). This honors the user's "if I exclude someone, it should always go to inbox" requirement — we don't want AI to override the explicit exclusion.
- Reason strings update accordingly: `Excluded from "Factory" by rule: from contains "ceo@chevrolet.com"`.

Folder editor UI (`src/components/folders/FolderEditor.tsx`):

- Add `not_contains` and `not_equals` to the op `Select`.
- Render exclude rules with a distinct red/destructive style and an "Exclude" label so it's obvious at a glance.
- Inline shortcut in the email reader's "Move similar" / sender area: "Exclude this sender from <Folder>" — adds a `from not_contains <email>` rule with one click. *(Optional polish; safe to defer.)*

### 2. Global inbox exclude list

New table `public.inbox_overrides`:

```
id uuid pk
user_id uuid not null
match_type text not null check (match_type in ('email','domain'))
value text not null   -- normalized lowercase
note text             -- optional user-written reason
created_at timestamptz default now()
unique (user_id, match_type, value)
```

RLS: `auth.uid() = user_id` for all ops.

Sync engine: very first check after parsing the message — if `from_addr` matches an `email` override or the from-domain matches a `domain` override, skip Gmail-label routing, filters, and AI. Set:

- `folder_id = null`
- `classified_by = 'global_exclude'`
- `classification_reason = 'Global exclude: <value>'`

Note on Gmail labels: if the user has *manually* applied a folder's linked Gmail label to that message in Gmail, that's an explicit human signal and we should still respect it. So the precedence is:

```
manual Gmail label  →  global exclude  →  folder rules (with excludes)  →  AI
```

I'll surface this in the plan UI copy so the behavior isn't surprising.

### 3. Settings UI for the global list

New section in the existing Settings page (or a small dedicated page if Settings has no good slot — I'll check on implementation): "Always send to inbox". Lists current overrides, lets the user add by full email address or by domain, and remove individual entries. Real-time list via `supabase.from('inbox_overrides')`.

### 4. Reader "Why this folder?" updates

The TriggeredBy block we just added gets two new cases:

- `global_exclude` → "On your global inbox list — never auto-sorted."
- `excluded` (folder had include + exclude both fired) → "Would have matched <Folder>, but excluded by rule: …" (stays in inbox).

### Files touched

- **migration** — create `inbox_overrides` + RLS.
- `src/lib/sync.server.ts` — operator extension, exclude semantics, global override short-circuit.
- `src/components/folders/FolderEditor.tsx` — new ops in the rule editor + exclude styling.
- `src/routes/_authenticated/index.tsx` — TriggeredBy cases for `global_exclude`.
- `src/routes/_authenticated/settings.tsx` (or wherever Settings lives) — global override CRUD section.

No edge functions. All server-side work runs through the existing sync pipeline.

## Question before I build

Two small calls I want to confirm so I don't ship the wrong behavior:

1. When a folder has `domain contains "honda.com"` AND `from not_contains "ceo@honda.com"`, and CEO's email arrives — you want it to **stay in inbox** (skip AI entirely), right? Or would you rather let AI take another pass at routing it elsewhere?
2. For the global list, if you've manually applied the folder's Gmail label to a sender's message in Gmail itself, should that still win over the global exclude? (My default: yes — manual Gmail labels are explicit human intent.)