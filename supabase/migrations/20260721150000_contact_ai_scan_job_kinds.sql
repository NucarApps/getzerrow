-- Extend the background contact-AI job queue with whole-user scan kinds so
-- the interactive "AI tools" scans (duplicate detection, inbox signature
-- enrichment) run through the 2-minute worker instead of inside one HTTP
-- request. The old inline scans issued up to 80 (dedup) / 40 (enrichment)
-- sequential model calls per request — far past this host's wall-time — so
-- the request died and the tools looked broken.

ALTER TABLE public.contact_enrich_jobs
  DROP CONSTRAINT IF EXISTS contact_enrich_jobs_kind_check;
ALTER TABLE public.contact_enrich_jobs
  ADD CONSTRAINT contact_enrich_jobs_kind_check
    CHECK (kind IN ('bio', 'suggest', 'dedup_scan', 'signature_scan'));

ALTER TABLE public.contact_enrich_jobs
  DROP CONSTRAINT IF EXISTS contact_enrich_jobs_contact_required;
ALTER TABLE public.contact_enrich_jobs
  ADD CONSTRAINT contact_enrich_jobs_contact_required
    CHECK (kind IN ('suggest', 'dedup_scan', 'signature_scan') OR contact_id IS NOT NULL);
