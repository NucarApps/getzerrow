## Plan: stop iOS PUTs with an empty EMAIL line from clearing the saved address

### What the DB shows
Ten `carddav_put` revisions for Chanell in the last 40 min. Every "before-PUT" snapshot has `email = null`, yet Google's `last_synced_at = 1970` (dirty sentinel) and Google sync is `pull_only` and hasn't run in 13 hours. So Google is not the culprit — iOS's own PUTs are wiping the email between edits.

### Root cause
1. `src/lib/carddav/vcard.ts` `parseVCard()` case `"EMAIL"` calls `out.presentFields.add("EMAIL")` unconditionally, even when the EMAIL line has an empty value. It also has this branch:
   ```
   else if ((p.params.TYPE ?? []).includes("PREF")) out.email = v.trim() || null;
   ```
   A later, blank `EMAIL;TYPE=pref:` overwrites the previously-parsed real address with `null`.
2. `src/lib/carddav/handlers.server.ts` `handlePut` then does:
   ```
   if (present.has("EMAIL")) {
     plaintextPatch.email = parsed.email ? … : null;
   }
   ```
   → writes `email = null` on any PUT that contains an EMAIL line with no value.

Result: user saves email on iPhone → server stores it. iOS's next background PUT (a partial vCard containing an empty EMAIL slot) marks EMAIL "present" with value null → server overwrites to `null` → iOS re-pulls and shows blank.

### Changes

1. **Parser: only count EMAIL as present when a real value arrived** (`src/lib/carddav/vcard.ts`)
   - Track `sawEmailValue` locally in the EMAIL case. Only call `presentFields.add("EMAIL")` when the trimmed value is non-empty.
   - Fix the PREF-overwrite branch so an empty PREF EMAIL never nulls a previously-parsed non-empty one.
   - Apply the same "only present when non-empty" rule to TEL, URL, ORG, TITLE, ADR, NOTE — any of these can arrive blank from iOS on partial syncs, and unconditionally marking them present risks the same class of bug for other fields.

2. **Handler: defensive non-destructive email merge** (`src/lib/carddav/handlers.server.ts`, `handlePut`)
   - When `present.has("EMAIL")` but `parsed.email` is null AND `existing?.email` is set, do NOT overwrite. Log a `carddav.put.email_preserved_over_blank` info line with `contact_id` and body length so we can spot future occurrences.
   - Only allow clearing email to null via CardDAV when the contact previously had no email (new contact) or the caller explicitly sent an empty EMAIL AND had no other identifying fields removed.

3. **Diagnostic breadcrumb**
   - Add a lightweight `logInfo("carddav.put.received", { contact_id, present_fields, has_email_value, body_len })` at the top of `handlePut` (after parse). Cheap, no PII, will make the next report diagnosable without new tooling.

4. **Regression tests**
   - `src/lib/carddav/vcard.parse.test.ts`: PUT with `EMAIL;TYPE=INTERNET;TYPE=pref:` (empty value) must NOT mark EMAIL present and must leave `parsed.email` null.
   - PUT with two EMAIL lines where the second (PREF) is blank must keep the first real address in `parsed.email`.
   - Same for `TEL:` empty and `ORG:` empty — presentFields must NOT include them.
   - New `handlers.server` test (or extend existing carddav sync test): existing contact with `email = "jane@acme.com"`; PUT a vCard containing an empty EMAIL line; assert the row's email is unchanged after handlePut.

5. **Bump CTag** so iPhone re-fetches once the fix is live (increment `carddav_settings.resync_nonce` for this user, as we've done for prior CardDAV fixes).

### Validation
- Run `bunx vitest run src/lib/carddav`
- Re-check `contact_revisions` for Chanell after the next round of iOS PUTs — snapshots should now show the real email as the pre-PUT state instead of null.
- Confirm the new `carddav.put.received` log fires with `has_email_value: false` on the PUTs that used to wipe the field.

### Out of scope
- Google Contacts push/pull (`sync_mode = pull_only`, last run 13h ago — not involved).
- Broader multi-email support; single primary email only, matching current schema.
