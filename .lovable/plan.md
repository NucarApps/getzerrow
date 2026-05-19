Your Factory folder is empty because of two bugs:

1. Linking a Gmail label to a folder only seeds AI training examples — it never imports the labeled messages into the inbox, and it never tags messages already in the database with that `folder_id`.
2. The inbox query filters `is_archived = false`, so messages that carry the Gmail label but aren't in the Gmail "Inbox" (which is the normal case for filed/labeled mail) are hidden from the folder view.

Plan:

- **Ingest + claim on link**
  - When a folder is linked to a Gmail label (initial link and the "Re-learn" button), pull the messages with that label and:
    - Insert any that aren't already stored (even when they aren't in `INBOX`, marking them as archived so they don't leak into All inbox).
    - Update any matching existing rows to set `folder_id` to this folder.
    - Continue to seed training examples and regenerate the AI profile (existing behavior).
  - Cap to the most recent N messages to keep this fast.

- **Show labeled messages in their folder regardless of archive state**
  - In the inbox view, when a real folder is selected, query emails by `folder_id` directly (don't apply the `is_archived = false` filter).
  - Keep "All inbox" and "Unsorted" filtered to `is_archived = false` as today.
  - Apply the same logic to the sidebar unread counts so a folder's count reflects unread labeled mail even if it's archived.

- **Keep new labeled mail flowing in**
  - Existing `processGmailMessage` already assigns `folder_id` when a message has a folder's Gmail label, so no change there.
  - Confirm history sync still tags newly-labeled messages via the existing `labelsAdded` handler.

- **Validate**
  - Open the Factory folder and confirm previously-labeled mail now appears.
  - Confirm All inbox counts are unchanged.