Condense the top of the email pane (above the body) so subject, sender, summary, and "Why this folder?" trigger take less vertical space.

Changes to `src/routes/_authenticated/inbox.tsx`:

1. **Container padding** (line 853): `p-4 md:p-6` → `px-4 md:px-6 pt-3 pb-4` — cut top padding roughly in half.

2. **Subject** (line 854): `text-2xl md:text-3xl` → `text-xl md:text-2xl` so the title is still prominent but not oversized.

3. **Sender line** (lines 855-859): drop to `mt-1 text-xs` (from `mt-2 text-sm`) and shorten the timestamp to a localized date+short time (e.g. `5/20/26, 8:51 PM` via `toLocaleString([], { dateStyle: "short", timeStyle: "short" })`).

4. **Summary card** (lines 860-865): drop `mt-3` to `mt-2`, and trim padding `px-3 py-2` → `px-2.5 py-1.5`. Keep the sparkles + "Summary ·" + text inline.

5. **"Why this folder?" trigger** (lines 867-877): drop `mt-2` to `mt-1.5`, and `py-1.5` → `py-1`. Keep the chip and chevron.

6. **Body spacing** (line 912): `mt-6` → `mt-4`.

Result: the header block shrinks ~30–40% in height while keeping subject, sender, time, summary, and the why-this-folder collapsible all visible.

No changes to the collapsible content, the message list, or any business logic.