UPDATE public.emails e
SET is_read = false
FROM public.folders f
WHERE e.folder_id = f.id
  AND f.auto_mark_read = false
  AND e.is_read = true;