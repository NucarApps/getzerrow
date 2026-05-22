## Goal

Add a "+ Add" button on the Contacts page that opens a dialog with two tabs:
1. **Manual** — type in someone's details (name, email, title, company, phone).
2. **From inbox** — browse unique sender emails pulled from your inbox, filterable by one or more folders, and check off the ones to add.

## Changes

### 1. `src/lib/contacts.functions.ts` — new server functions

**`createContactManual`** — `{ email, name?, title?, company?, phone?, website?, linkedin?, twitter? }`
- Validate email; lowercase + trim.
- `supabaseAdmin.from("contacts").upsert(..., { onConflict: "user_id,email" })` with `source: "manual"`.
- Run name through `normalizeName`.
- Return the row. (Enrichment happens lazily on next contact open, same as existing flow.)

**`listFoldersForPicker`** — returns `[{ id, name, color }]` for the user's folders (lightweight, no counts).

**`listUniqueInboxSenders`** — `{ folderIds?: string[], search?: string, limit?: number }`
- Query `emails` for the current user, optionally filtered by `folder_id IN (folderIds)`.
- Aggregate in JS: group by lowercased `from_addr`, pick best `from_name` (longest non-empty), count, latest `received_at`.
- Exclude addresses that already exist in `contacts` for this user.
- Filter out addresses where `isLikelyHuman(addr)` is false (reuses existing helper — drops noreply/notifications/etc.).
- Apply `search` against name/email.
- Sort by count desc, return top `limit` (default 200).
- Return `[{ email, name, count, lastReceivedAt }]`.

**`bulkCreateContactsFromEmails`** — `{ items: [{ email, name? }] }` (max ~100)
- Upsert each with `source: "email"` via `supabaseAdmin`.
- Return `{ created: number }`.

### 2. `src/routes/_authenticated/contacts.index.tsx`

- Add an "Add" button (Plus icon) in the header next to "Scan card".
- Click opens a new `AddContactsDialog` component with two tabs (`Tabs` from shadcn).

**Manual tab:**
- Fields: Email (required), Name, Title, Company, Phone, Website, LinkedIn, Twitter.
- "Add contact" button calls `createContactManual`, toasts, invalidates `["contacts"]`, optionally navigates to the new contact's detail page.

**From inbox tab:**
- Folder multi-select chips at top: "All folders" + each of the user's folders (toggle to include).
- Search input.
- Scrollable list of unique senders with a checkbox per row showing `Name`, `email`, last-seen date, and count of messages.
- "Select all visible" + counter ("3 selected").
- "Add N contacts" button calls `bulkCreateContactsFromEmails`, toasts, invalidates `["contacts"]`, closes dialog.
- Result list refetches when folder selection or search changes (debounced search).

### 3. Out of scope
- No auto-enrich on bulk add (will run on first open of each contact, same as today).
- No edit-before-add for inbox senders (just the name we already have).
- No persistent draft state for the dialog.
- No changes to the contact detail page.
