## Why "Learn" returned 0 emails

In `learnFromLinkedLabel` (src/lib/sync.server.ts:259) we call:

```ts
listMessages({ maxResults: 50, q: `label:${folder.gmail_label_id}` })
```

`folder.gmail_label_id` is the Gmail label **ID** (e.g. `Label_4831…`). Gmail's search operator `label:` expects the label **name** (e.g. `Inbox Zero/Factory`, with `/` replaced by `-` and spaces escaped) — not the ID. So the query matches nothing and we record 0 examples.

The correct way to filter by label ID is the dedicated `labelIds` query parameter on `users.messages.list`, which takes the raw ID.

## Fix

1. **`src/lib/gmail.server.ts` — extend `listMessages`** to accept `labelIds?: string[]` and append each as a repeated `labelIds=` query param (Gmail accepts multiple).

2. **`src/lib/sync.server.ts` — `learnFromLinkedLabel`** switch from `q: 'label:…'` to `labelIds: [folder.gmail_label_id]`. Keep the rest (fetch each message, upsert into `folder_examples` as `seed`, regenerate `learned_profile`, stamp `last_learned_at`) unchanged.

3. **Guard against empty results with a clearer toast**: if Gmail returns 0 messages for the linked label, surface "No emails found under linked label — make sure the label has messages" instead of the current silent "Learned from 0 emails". (Frontend toast string in `folders.tsx`.)

No schema changes, no UI restructuring — just the query fix plus a friendlier message.