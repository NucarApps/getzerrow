## What's already there

`Reader` in `src/routes/_authenticated/index.tsx` already calls `markEmailRead` on open:

```tsx
useEffect(() => {
  if (!email.is_read) {
    markFn({ data: { id: email.id, read: true } })
      .then(() => qc.invalidateQueries({ queryKey: ["emails"] }));
  }
}, [email.id]);
```

So functionally it does mark as read. The problem you're feeling is the **delay**: the row stays bold and the sidebar count stays elevated until the server round-trip + refetch completes (typically 200–800ms). If you click back quickly, it still looks unread.

## Fix — optimistic update

Patch the `["emails"]` cache locally the moment a user opens an unread email, then let the server confirm.

In `src/routes/_authenticated/index.tsx` `Reader`, replace the existing effect with:

```tsx
useEffect(() => {
  if (email.is_read) return;
  // 1. Optimistic: flip the row in cache immediately
  qc.setQueryData<Email[]>(["emails"], (prev) =>
    prev?.map((e) => (e.id === email.id ? { ...e, is_read: true } : e)),
  );
  // 2. Persist + sync Gmail
  markFn({ data: { id: email.id, read: true } })
    .catch(() => qc.invalidateQueries({ queryKey: ["emails"] })); // rollback on failure
}, [email.id]);
```

This makes the row de-bold and the sidebar count drop **instantly** when the email opens. The server call still runs in the background to update Gmail and the DB row; if it fails, we re-fetch to restore the truth.

## Out of scope

- No backend, schema, or other UI changes.
- No change to manual read/unread toggle behavior (existing button still works).
- No change to mark-as-read behavior in the list (still requires opening — same as before).

## Files

- `src/routes/_authenticated/index.tsx` — swap one `useEffect` body.
