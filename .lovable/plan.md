# Reprocess GM Responses — manual walkthrough (no code changes)

Goal: cleanly evict the 236 external-domain emails now blocked by the folder allowlist. The **Re-classify** action re-runs each email through the (updated) rules; because the allowlist now vetoes external domains, each one is restored to the inbox and its Gmail folder label is stripped via the Gmail API — no database desync, nothing gets reverted on the next sync.

## Why this works
- Re-classify calls the same classifier your live mail uses. The deterministic domain allowlist vetoes external senders, so the email ends up with **no folder** → it's moved back to the inbox (`is_archived = false`, `INBOX` label re-added, folder label removed in Gmail).
- This is independent of the 0.99 confidence gate — the allowlist veto is deterministic, so you do **not** need to relax 0.99 to clear these. (That setting only affects how *new* mail gets AI-filed later.)

## The constraint that sets the batch size
- In a folder view, **Select all** selects the currently loaded page = **50 emails**.
- A single Re-classify call is capped at **100 emails** server-side.
- So the practical batch is one page (50). 236 emails ≈ **5 rounds** (50 + 50 + 50 + 50 + 36).

## Steps

```text
1. Open Inbox.
2. In the folder sidebar, click "GM Responses".
   → The list now shows the archived emails filed there.
   → Note the folder count next to it (should be ~236).
3. Click "Select all" (selects the 50 on this page).
4. Click "Re-classify" (outline button, circular-arrow icon).
   → Wait for the toast: "Re-classified · N routed, M unchanged, …".
   → "routed" = evicted back to inbox. Those rows disappear from this folder.
5. The list refreshes to the next 50. Repeat steps 3–4.
6. Stop when the folder count reaches your legitimate remainder
   (internal-domain mail that still belongs), i.e. when a round reports
   "0 routed" / only "unchanged". That's the done signal.
```

## What to expect per round
- **routed** = external-domain emails evicted to the inbox this round.
- **unchanged** = emails that still legitimately match (internal domains) — these stay in GM Responses. Once every remaining email is "unchanged," you're finished.
- **failed** = transient errors (e.g. a Gmail API hiccup). Just run one more round on the folder; failed items are retried and usually clear.

## After you finish
- The evicted emails are back in your inbox with the Gmail "GM Responses" label removed. Because eviction goes through the Gmail API, the next sync won't revert them.
- New external-domain mail is already blocked by the allowlist, so this cleanup is a one-time pass.

## If 5 manual rounds feels tedious
Say the word and I'll switch to build mode and add a one-click "Reprocess whole folder" action that loops server-side in batches (like the existing override-reprocess path) so all 236 clear in a single click.
