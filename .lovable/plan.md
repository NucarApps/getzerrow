## Goal

Two coupled changes to the right-hand email reader pane:

1. Replace the always-visible Reply box with a **Reply button**. Clicking it slides a reply composer **up from the bottom of the email pane** (not the whole page, not a full-screen sheet). Clicking a close (×) button slides it back down.
2. Lock the reader pane layout so the **page itself never scrolls** — only the email content area scrolls. Header (toolbar) stays pinned at top, reply drawer overlays the bottom of the pane.

## Current state

`Reader` (`src/routes/_authenticated/inbox.tsx`, lines ~708–946) is already `flex h-full flex-col` with:
- Header toolbar (lines 710–853)
- Scrollable content `<div className="flex-1 overflow-y-auto p-4 md:p-6">` (lines 855–921)
- **Always-on** reply panel at bottom (lines 923–946) with textarea + Suggest reply + Send

The outer reading pane wrapper is `<div className="h-full overflow-y-auto …">` (line 612) — this is what allows the whole pane to scroll when content is tall.

## Changes — `src/routes/_authenticated/inbox.tsx`

### 1. Stop the pane wrapper from scrolling (line 612)

Change `overflow-y-auto` → `overflow-hidden` on the reading-pane wrapper. The `Reader` already has its own internal scroll area (`flex-1 overflow-y-auto`), so only the email content scrolls; the header and the reply drawer stay pinned.

### 2. Convert the reply panel into a slide-up drawer

In `Reader`:
- Add `relative` to the root `<div className="flex h-full flex-col">` (line 709) so the drawer can absolutely position against it.
- Add new state: `const [replyOpen, setReplyOpen] = useState(false);`
- **Remove** the existing always-on reply block (lines 923–946).
- Add a **Reply button** in the header toolbar (line 722 area, next to the other ghost icon buttons) — `<Button size="sm" variant="ghost" onClick={() => setReplyOpen(true)}><Reply className="h-4 w-4" /></Button>` (import `Reply` from lucide-react). Place it as the first/most prominent action so it's easy to find.
- Add a new slide-up drawer just before the closing `</div>` of the Reader, positioned `absolute inset-x-0 bottom-0` inside the reader pane:

  ```tsx
  <div
    className={`absolute inset-x-0 bottom-0 border-t border-border bg-card shadow-2xl transition-transform duration-300 ease-out ${
      replyOpen ? "translate-y-0" : "translate-y-full"
    }`}
  >
    <div className="flex items-center justify-between border-b border-border px-4 py-2">
      <span className="text-xs uppercase tracking-widest text-muted-foreground">
        Reply to {email.from_name || email.from_addr}
      </span>
      <div className="flex items-center gap-1">
        <Button size="sm" variant="ghost" disabled={generating} onClick={…suggest…}>
          <Sparkles className="mr-1.5 h-3.5 w-3.5" />
          {generating ? "Drafting…" : "Suggest reply"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setReplyOpen(false)} aria-label="Close reply">
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
    <div className="p-4">
      <Textarea rows={6} value={reply} onChange={…} placeholder="Write a reply…" />
      <div className="mt-2 flex justify-end">
        <Button size="sm" disabled={!reply.trim() || sending} onClick={async () => { …send…; setReplyOpen(false); }}>
          <Send className="mr-1.5 h-3.5 w-3.5" />Send
        </Button>
      </div>
    </div>
  </div>
  ```

- Both `Suggest reply` and `Send` move into the drawer; their handlers and state (`reply`, `generating`, `sending`, `genFn`, `sendFn`) are unchanged.
- After a successful send, also call `setReplyOpen(false)` to slide the drawer back down.

### 3. Detail: drawer height & content overlap

The drawer is `absolute`, so it overlays the scrollable email content without resizing it. When open it covers the lower ~40–50% of the pane (its height is driven by content: header strip + 6-row textarea + send button). The email content area underneath remains scrollable — the user can still scroll the email behind the drawer if needed. This matches typical Gmail / Front behavior.

No animation library required — pure Tailwind `translate-y-full` ↔ `translate-y-0` with `transition-transform`.

## Files

- `src/routes/_authenticated/inbox.tsx` — pane wrapper overflow change (line 612), Reader root `relative` (line 709), add Reply button in header toolbar (~line 722), remove always-on reply panel (lines 923–946), add slide-up drawer in its place, add `replyOpen` state, import `Reply` and `X` from `lucide-react` (already imports `X`).

No other files, no backend/server changes.
