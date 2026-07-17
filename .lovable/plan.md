## Goal

iOS Contacts only shows a flat list of groups (no nesting). Right now Zerrow's CardDAV renders nested Zerrow groups as `Parent / Child` for subgroups and just the leaf name for top-level groups. You want to pick the display format per account so a subgroup like Factory → Toyota can appear on iPhone as `Factory - Toyota`, while still keeping the current behavior as an option.

## What you'll see

On **Settings → iPhone contacts**, a new "Group names on iPhone" selector with three options:

- **Leaf name only** — `Toyota`
- **Parent / Child** (current) — `Factory / Toyota`
- **Parent - Child** (new) — `Factory - Toyota`

Change applies to every connected iPhone; the CardDAV CTag bumps so iOS refreshes group names on next sync (no re-add needed).

Only the `FN`/`N` fields on group vCards change. Contacts, memberships, group→folder links, and the sender_in_group filter engine are untouched.

## Technical details

1. Migration: add `carddav_group_name_style text not null default 'path_slash'` to the existing per-user CardDAV settings table (or `user_settings` — I'll pick whichever already holds CardDAV prefs; if none exists, add a small `carddav_settings` table with `user_id` PK + GRANTs + RLS).
2. `src/lib/carddav/handlers.server.ts`
   - Extend `resolveGroupDisplayName` to accept a style and format accordingly (`leaf` → own name; `path_slash` → join with ` / `; `path_dash` → join with ` - `).
   - Load the style once per PROPFIND/REPORT/GET request and pass it through the group-rendering helpers (`buildGroupCardResponse`, sync-collection group loop, single-group GET).
   - Include the style value in `computeBookCTag` (append to the hash source) so changing it invalidates iOS's cache.
3. `src/lib/carddav/tokens.functions.ts` (or a new `settings.functions.ts` next to it): add `getCardDavSettings` + `updateCardDavSettings` server fns behind `requireSupabaseAuth`.
4. `src/routes/_authenticated/settings.carddav.tsx`: add a `Select` card bound to those server fns; on save, toast "iPhone will refresh group names on next sync."
5. No changes to PUT/DELETE, vCard round-trip tests, or the CardDAV parent-path parser — those still write/read raw group names; the style only affects what iOS displays.

## Out of scope

- No new group-name format beyond the three above.
- No per-group override (setting is global per user).
- No change to how contacts, folders, or `sender_in_group` filters work.
