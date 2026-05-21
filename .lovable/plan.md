# Condense the email-detail summary + "Why this folder?" area

The Summary card and the "Why this folder?" trigger stack into a tall block. Tighten both so the email body shows higher on the page, without removing functionality.

## Changes in `src/routes/_authenticated/inbox.tsx`

**1. Summary card (lines 888–893)** — inline the "Summary" label with the text on a single row and reduce padding:

```tsx
{email.ai_summary && (
  <div className="mt-3 flex items-start gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
    <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
    <span><span className="font-medium text-primary">Summary · </span>{email.ai_summary}</span>
  </div>
)}
```

**2. "Why this folder?" trigger (lines 895–905)** — tighten vertical padding and top margin:

- Outer `<Collapsible>`: `mt-3` → `mt-2`.
- Trigger button: `py-2` → `py-1.5`.

No other changes — content/behavior of the collapsible body stays identical.

## Result
The two-row Summary card collapses into one tighter row, and the trigger row shrinks slightly. Email body moves up by roughly 30–40px on desktop. Nothing removed.
