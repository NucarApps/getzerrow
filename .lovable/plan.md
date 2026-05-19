# Suggested domains: add "move to another folder" action

Today each suggested-domain chip has one click action: add the domain as a routing rule for the current folder. We'll add a second action so you can also say "actually, this domain belongs in a different folder" — and have all matching emails reassigned automatically.

## UX

Restructure each chip in `FolderEditor.tsx` into a small two-part control:

- **Left (`+ domain · N`)** — same as today, routes the domain to the current folder.
- **Right (`→` arrow icon button)** — opens a small popover with a searchable list of the user's other folders. Picking one:
  1. Removes the chip from suggestions.
  2. Adds the `domain contains <domain>` filter to the chosen folder.
  3. Reassigns every email currently in this folder whose `from_addr` ends in `@<domain>` to the chosen folder (also strips the current folder's Gmail label and applies the chosen folder's label, if linked).
  4. Toast: `Moved N emails from Factory → Receipts and routed future ones`.

Both actions live inside the same chip so the suggestion list stays compact.

## Server work

Add one new server function in `src/lib/gmail.functions.ts`:

`reassignDomainToFolder({ from_folder_id, to_folder_id, domain })`
- Authorize both folders against `context.userId`.
- Insert a `folder_filters` row on the destination (skip if already present).
- Select emails where `user_id = me AND folder_id = from_folder_id AND lower(from_addr) LIKE '%@<domain>'`.
- Update those rows: `folder_id = to_folder_id`, `classified_by = 'domain_rule'`, `ai_confidence = 1`.
- For each affected `gmail_message_id`, call Gmail `messages.modify` to remove the source folder's `gmail_label_id` (if any) and add the destination folder's `gmail_label_id` (if any). Best-effort, batched, ignore per-message Gmail errors so a label hiccup doesn't roll back the DB move.
- Return `{ moved: number }`.

Reuse existing helpers from `sync.server.ts` / `gmail.server.ts` for the Gmail token + modify call — no new auth plumbing.

## Client wiring

In `FolderEditor.tsx`:
- New `useQuery(["folders-picker"])` (or reuse the existing folders list already loaded by the parent) for the popover options, filtered to exclude the current folder.
- New `reassignFn = useServerFn(reassignDomainToFolder)` with optimistic chip removal mirroring the existing `addDomain` pattern.
- Invalidate `["emails"]`, `["folder-domains", ...]`, `["folder-filters", to_folder_id]`, sidebar counts.

## Out of scope

- No bulk-undo flow; the move is reversible by repeating the same action in the other direction.
- No change to how new incoming mail is classified — the inserted `folder_filters` row already covers future messages via existing routing logic.
