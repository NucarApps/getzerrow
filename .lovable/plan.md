## Confirm: real manual Gmail moves still register as Manual

The fix from the previous turn already preserves this. Walking through the cases:

| Scenario | Row before event | Skip? | Result |
|---|---|---|---|
| Our AI/filter classifies into Factory, Gmail echoes labelsAdded for Factory | `folder_id=Factory, classified_by=ai` | **Yes** | Stays "AI" ✓ |
| User manually drags an email into Factory in Gmail (was in Inbox / no folder) | `folder_id=null` or different | No | Recorded as **manual_move** ✓ |
| User moves from Folder A → Folder B in Gmail | `folder_id=A` ≠ B | No | Recorded as **manual_move** ✓ |
| User re-applies Factory label to an email already in Factory via AI | `folder_id=Factory, classified_by=ai` | Yes | Stays "AI" (no-op label) ✓ |

The skip condition requires **both** `folder_id === folder.id` **and** an auto-classified `classified_by`. Any genuine user move from Gmail's UI fails one of those two checks, so it still gets recorded as `manual_move`.

### No code changes needed

The current implementation already does what you want. No plan to execute.

If you want extra confidence we could also add a short-window guard (e.g. skip only if our row was updated in the last 60s) but that's optional and the folder-match check is already sufficient.
