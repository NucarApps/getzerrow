# Remove "AI INBOX" caption from sidebar

Delete line 178 of `src/routes/_authenticated.tsx`:

```tsx
<p className="text-[11px] uppercase tracking-widest text-muted-foreground">AI inbox</p>
```

The Zerrow logo on line 176 stays. Nothing else changes.
