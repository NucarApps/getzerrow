# Fix: Calendar guard should only block the Cold Email folder

## Problem

Emails from senders you've met in Google Calendar (e.g. `james.decrispino@cadillac.com`) stopped filing into **Factory** and now sit in the inbox as "unclassified".

Root cause: the classifier runs the calendar guard **first** and stops there for any known contact — pinning them to the inbox and skipping all your folder rules. Before this sender was added to your calendar contacts (6/1), his mail correctly matched the `cadillac.com` → Factory domain rule.

Your intent: the guard should only prevent a known contact from being filed as **cold email**. Every other rule (Factory domain rule, other filters, AI folders) should work normally.

## Approach

Identify which folder is the "Cold Email" folder explicitly (a folder flag), then change the guard from "pin everything to inbox" to "only block the Cold Email folder".

```text
Before:  known contact ──► INBOX (skips all rules)

After:   known contact ──► run all rules normally
                           │
                           ├─ matches Factory domain rule ──► Factory ✓
                           ├─ AI/filter would pick Cold Email ──► blocked, kept in inbox
                           └─ nothing matches ──► inbox
```

## Changes

### 1. Database
Add an `is_cold_email` flag to folders (default off) and turn it on automatically for any existing folder named "Cold Email", so the fix works immediately for your current setup.

### 2. Classifier (`src/lib/sync/classify.ts`)
- Remove the early guard short-circuit.
- Compute `isGuardedContact = guard enabled AND sender is a known calendar contact`.
- When the AI candidate set is built, drop `is_cold_email` folders for guarded contacts so the AI can't file them there.
- After a folder is resolved (filter / label / AI), if the chosen folder is `is_cold_email` and the sender is a guarded contact, clear the assignment and keep the email in the inbox (`classified_by = "calendar_contact"`, reason "Met in Google Calendar — kept out of Cold Email").
- All other paths (Factory domain rule, gmail-label match, inbox overrides, other AI folders) are untouched.

### 3. Folder editor (`src/components/folders/FolderEditor.tsx`)
Add a small toggle "Cold email folder — keep calendar contacts out" so you can designate which folder the guard protects against (pre-set for the existing Cold Email folder).

### 4. Settings copy (`src/components/settings/CalendarGuardCard.tsx`)
Tweak the description to reflect the narrower behavior: known contacts are never filed as cold email, but other folder rules still apply.

### 5. Reclassify stuck emails
Re-run classification on the recent emails currently pinned as `calendar_contact` so they flow into their correct folders (e.g. the cadillac.com messages move into Factory).

### 6. Tests (`src/lib/sync-classify.test.ts`)
- Update the existing guard tests (which assert the guard beats folder filters) to the new behavior.
- Add: a guarded contact whose domain matches Factory files into Factory; a guarded contact that would land in Cold Email is kept in the inbox instead.

## Technical notes
- `account-context.ts` already loads folders with `select("*")`, so the new column flows through automatically; the `Folder` type in `src/lib/sync/types.ts` gains `is_cold_email: boolean`.
- The account-context cache (TTL) means the new flag takes effect on the next cache refresh; reclassification in step 5 uses fresh context.
