## Update Privacy Policy with Google User Data protection details

Add a new "How we protect Google user data" section to `src/routes/privacy.tsx`, plus tighten existing sections so they explicitly meet Google's Limited Use / API Services User Data Policy disclosure requirements.

### Changes to `src/routes/privacy.tsx`

1. **Bump "Last updated" date** to May 28, 2026.

2. **New section: "How we protect Google user data"** (placed after "How we use it"). Covers:
   - Encryption in transit (TLS 1.2+) for all traffic between your browser, Gmail, and Zerrow.
   - Encryption at rest for stored messages, metadata, and folder rules in our database.
   - Google OAuth tokens stored encrypted with a server-held key (pgcrypto), never exposed to the browser.
   - Access controls: row-level security so each user can only access their own data; least-privilege service credentials.
   - Operational security: secrets stored in a managed secret store, audit logging, restricted production access for staff.
   - Security procedures and reviews are in place to protect the confidentiality of your data.

3. **New section: "Limited Use of Google user data"** (right after the section above) — explicit Google-required language:
   - Zerrow's use and transfer of information received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements.
   - Google user data is used only to provide and improve the user-facing features of Zerrow (classification, filing, summaries, reply drafts).
   - We do not sell Google user data, do not use it for ads, do not transfer it except as necessary to provide the service, and do not allow humans to read it except with your consent, for security/abuse investigations, for legal reasons, or where data has been aggregated and anonymized.
   - No Google user data is used to train generalized/third-party AI models.

4. **Tighten "Sharing"** to name categories of subprocessors (hosting on Cloudflare, database/auth on Supabase via Lovable Cloud, AI classification via Lovable AI Gateway) and reiterate no sale/no ads.

5. **Tighten "Retention & deletion"** to clarify that disconnecting Gmail revokes OAuth tokens and stops further syncing, and that account deletion removes synced messages, jobs, and the encrypted OAuth record within 30 days.

6. **Update meta description** to mention security and Google user data protection so the page is discoverable for Google's OAuth verification review.

No business logic, routing, or backend changes. UI styling and structure (Section helper, color tokens, fonts) stay as-is.
