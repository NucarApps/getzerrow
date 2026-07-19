## Why the labels differ even though the contacts "look" like Nissan

I checked the actual data for those 7 Nissan contacts. Two separate things are going on:

**1. There are 4 different Nissan *company records* under the hood, and the contacts point to different ones.**

The Company dropdown shows a name, but the underlying `company_id` on each contact can point to any of these:

| Contact | Free-text `company` field | Linked `company_id` → record |
|---|---|---|
| Aditya Jairaj | Nissan North America | **Nissan Northeast Region** |
| Chad Faith | Nissan North America | **Nissan Motor Acceptance Company** |
| Julie Caltabiano | Nissan North America | **Nissan** |
| Gary / Joe / Katrina / Lou | Nissan North America | **Nissan North America** |

So even though every card *displays* "Nissan North America" in the company field, the linked entity is one of four different Nissan company rows. The auto-subgroup pass creates a label per linked company, hence 4 different Nissan child labels under the parent "Nissan" label.

**2. Historical labels never got cleaned up.**

Every one of those 7 contacts is currently a member of *all four* Nissan child labels (Nissan, Nissan Motor Acceptance Company, Nissan North America, Nissan-usa.com). Earlier reconcile passes added each contact to whichever label matched at the time (company name, then company_id, then raw email domain) but never removed them from the previous one. So the labels multiplied and every contact stayed pinned to the old ones.

## Fix plan

**Step A — Merge the underlying company records (root cause).**
Go to Contacts → Companies → "Find duplicates". Pick **Nissan North America** as canonical and fold Nissan, Nissan Motor Acceptance Company, and Nissan Northeast Region into it (keep Boch Nissan South and Nissan Of Keene — those are separate dealerships). Merging reassigns every contact's `company_id` to the survivor and re-runs the subgroup reconcile against the single canonical company.

**Step B — Clear the stale label memberships.**
After the merge, the reconcile only adds contacts to the canonical label; it does not delete their membership in the retired labels. So we add a one-shot "prune stale auto-subgroups" pass that, for each contact, removes it from any auto-generated sibling subgroup whose `company_id` no longer matches the contact's current `company_id`. Then the retired empty labels are deleted.

**Step C — Fix the domain-string label ("Nissan-usa.com").**
Add `nissan-usa.com` to the surviving Nissan company's domains so that label never gets recreated on the next reconcile.

The pruning in Step B is a small code change to `reconcileAutoParentsForContacts` (about 30 lines). Steps A and C are data cleanup you can do from the UI once the pruning ships.

Want me to build the Step B pruner? That's the piece that actually stops this from re-happening after future merges.