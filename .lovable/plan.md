## Fix Inbox Report 1000-row cap

The PostgREST backend caps each response at 1000 rows regardless of `.limit()`, so `getInboxReport` only ever sees the most recent 1000 emails — that's why all the stats are stuck at ~1000.

### Change — `src/lib/reports.functions.ts`

Replace the single `.from("emails").select(...).limit(ROW_CAP)` call with a paginated loop using `.range(from, to)`:

1. Keep the existing `ROW_CAP = 20000` and 90-day `since` filter.
2. Page in chunks of `PAGE_SIZE = 1000` ordered by `received_at desc`:
   ```ts
   for (let from = 0; from < ROW_CAP; from += PAGE_SIZE) {
     const to = Math.min(from + PAGE_SIZE - 1, ROW_CAP - 1);
     const { data, error } = await supabase
       .from("emails")
       .select("from_addr,from_name,received_at,folder_id,is_read,has_attachment")
       .gte("received_at", since)
       .order("received_at", { ascending: false })
       .range(from, to);
     if (error) break;
     const batch = data ?? [];
     emails.push(...batch);
     if (batch.length < PAGE_SIZE) break; // no more rows
   }
   ```
3. `truncated` stays `emails.length >= ROW_CAP` so the UI can still flag it.
4. No other logic changes — aggregation, folder lookup, response shape all stay the same.

### Out of scope

- No UI changes to `src/routes/_authenticated/reports.tsx`.
- No schema or RLS changes.
- ROW_CAP stays at 20k (sane upper bound for a 90-day window; can be raised later if needed).