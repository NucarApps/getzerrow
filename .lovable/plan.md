## Enable company editing for name-only buckets (add domain, edit info)

Right now the pencil button on a company header only appears when the bucket has a domain (`b.kind === "company" && b.domain`). Buckets keyed by company name only — the ones that get created for contacts without an email — have no way to edit the company, add a domain, adjust logo, or attach groups. This closes that gap.

### What changes

**Contacts list (`src/routes/_authenticated/contacts.index.tsx`)**
- Show the pencil `onEdit` on any bucket with `b.kind === "company"`, including name-only buckets (no `&& b.domain` check).
- When there's no domain, pass `primaryDomain: null` and the bucket's normalized company name into the dialog instead of a domain.

**Company dialog (`src/components/contacts/CompanyAliasesDialog.tsx`)**
- Detect "no primary domain yet" mode (`primaryDomain === null`) and render a top **"Add primary domain"** section: single input + "Save" that validates as a domain (accepts `example.com` or `https://example.com/…`, strips protocol/path, lowercases). On save it calls `addCompanyAlias` with the new value as the primary domain for this company name (server side already treats the first entry as primary), then flips the dialog into normal mode.
- Company name inline rename already works via `renameCompanyForContacts` — keep it. It stays enabled in name-only mode so users can clean up the name before assigning a domain.
- Logo picker and group assignment sections: disable with an inline explainer ("Add a primary domain to enable logo and company groups") while `primaryDomain === null` — both features are keyed by domain today and changing that is out of scope for this pass.
- Alias list section: hidden until a primary domain exists (nothing to alias yet).

**No server-side changes.** `addCompanyAlias`, `renameCompanyForContacts`, and the existing bucket-collapse logic in `companyBuckets` already handle the case where a domain appears after the fact — on refetch, the bucket switches from name-keyed to domain-keyed automatically.

### Out of scope
- Editing per-contact fields (already available on the contact detail view).
- Making logo/group assignment work without a domain (would require re-keying those tables on `(user_id, normalized_name)` — separate change if you want it).
- Auto-suggesting a domain from contact emails (none exist for these buckets by definition).

### Verification
- Open a name-only company bucket (e.g. Brad Taylor's company) → pencil appears.
- In the dialog: rename the company → all members update. Enter a domain → dialog switches to normal mode; on close, the bucket collapses into the domain-keyed bucket (or becomes one).
- Logo/group sections show the disabled explainer until a domain is added, then become active.
