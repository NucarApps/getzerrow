## Plan

1. **Fix the contact drawer flicker**
   - Change the contact photo display so known company-logo snapshots stored in `avatar_url` do not override the live company logo fallback.
   - If a contact has a linked company and the stored photo is recognized as a company-logo echo/snapshot, render the current selected company logo instead of the stale signed contact photo.

2. **Make company-logo resolution consistent everywhere**
   - Reuse the linked company’s full domain list and logo choice, including cases where the saved choice is keyed to `nissan-usa.com` but fetches from `nissanusa.com`.
   - Update the reset/cleanup logic so it hashes the chosen linked-company logo domain, not only the contact email/website heuristic.

3. **Repair Aditya’s existing stale avatar state**
   - Clear Aditya’s stored `avatar_url` snapshot so his contact immediately falls back to the selected Nissan company logo.
   - Stamp the current company-logo hash so future CardDAV/iPhone echo uploads are ignored instead of becoming a personal avatar again.

4. **Add regression coverage**
   - Add/extend tests around the company-logo echo guard for the exact mismatch pattern: linked company domains include both `nissanusa.com` and `nissan-usa.com`, while the logo choice uses one as `domain` and the other as `source_domain`.

## Technical notes

- Confirmed Aditya has a real `avatar_url` saved, so the drawer first shows the logo fallback while the signed photo is loading, then switches to that stored stale photo once the signed URL resolves.
- Confirmed his linked company has `nissanusa.com` and `nissan-usa.com`, and the logo choice is stored as `domain = nissan-usa.com`, `source_domain = nissanusa.com`.