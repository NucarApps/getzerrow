UPDATE public.emails
   SET is_archived = false,
       classified_by = 'inbox_override',
       classification_reason = 'Restored: always-inbox rule (was incorrectly archived by old global_exclude logic)'
 WHERE classified_by = 'global_exclude'
   AND is_archived = true;