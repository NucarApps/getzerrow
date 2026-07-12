# Fix: Zerrow inbox shows empty even though mail is present

## What I confirmed from your data

- **Ingestion is healthy.** Your accounts are actively receiving mail (hundreds of messages in the last 2 days). This is not a Gmail→Zerrow delivery problem.
- **`chris@nucar.com` has exactly two emails** that are unarchived, INBOX-labeled, and unfiled — matching the two you see in Gmail. These satisfy the server-side inbox query, so the server *would* return them.
- Yet you reported that account's Zerrow inbox is **completely empty**. That points to a client-side selection bug, not the database or the pipeline.

## Root cause

The app remembers two things in the browser between visits:

- the **active account** (`zerrow.activeAccountId`)
- the **selected folder/view** (`zerrow.selectedFolder`) — and this is stored **globally, not per account**

When the app loads, `src/routes/_authenticated.tsx` reconciles the active account: if the stored account is missing or invalid, it silently falls back to the first account. **But it never re-validates the selected folder.** The folder is only reset to "Inbox" when you *manually* pick an account from the switcher dropdown.

So this happens:

```text
1. You were viewing a specific FOLDER under account A.
   selectedFolder = <folder-uuid belonging to account A>
2. Later the app auto-switches the active account to account B
   (chris@nucar.com) — e.g. stored account invalid, fresh load, cross-tab.
3. selectedFolder still = <account A's folder-uuid>.
4. The inbox queries scope="folder" with that uuid against account B.
   Account B has no emails in that folder → the list comes back EMPTY.
```

The inbox looks empty even though "Inbox" for that account has two emails, because the app is actually querying a stale folder that doesn't belong to the current account. Each of your accounts has its own folder set (e.g. `chris@nucar.com` has Customers, Factory, Orders, etc.), so a folder id from one account never matches another.

## The fix

Reconcile the selected folder the same way the active account is already reconciled, so a stale/foreign folder can never strand the inbox.

1. **`src/routes/_authenticated.tsx`** — in the existing reconcile effect (the one that falls back to `accounts[0]`), after the account's folder list loads, check whether `selectedFolder` is a real folder for the current account. If it's a folder UUID that isn't in this account's folders (and isn't one of the special views `all` / `all_mail` / `no_rules`), reset it to `"all"`. This mirrors the manual-switch behavior for the auto-switch path.

2. **`src/routes/_authenticated/inbox.tsx`** — add the same guard at the point where the query scope is derived, so that if `selectedFolder` is a UUID not present in the inbox page's own loaded folders, it treats the scope as `"all"` (and clears the stale value). This avoids a brief empty flash during the load-order race before the layout effect runs, and makes the inbox self-correct even if it mounts first.

Both components already load the account's folders and share the same folder-selection context, so resetting in one place propagates to the other. No backend, schema, or sync changes are needed.

## Verification

- Reproduce in the live app: set `zerrow.selectedFolder` to a folder id from a different account, load the inbox for `chris@nucar.com`, and confirm the two emails now appear (previously empty).
- Confirm that legitimately selecting a real folder for the current account still filters correctly.
- Confirm switching accounts via the dropdown still resets to Inbox.
- Run the existing test suite to ensure no regressions.

## Notes / out of scope

- Two of your other connected accounts (`shawn@nucar.com`, `terrabyte081632@gmail.com`) show `needs_reconnect` from expired Google credentials — they won't receive new mail until reconnected. That's separate from this inbox-display bug and not addressed here.
- This does not change how aggressively mail is auto-filed into folders; it only fixes the empty-inbox display caused by the stale folder selection.
