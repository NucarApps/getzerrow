UPDATE public.emails e
   SET folder_id = NULL,
       classified_by = 'gmail_unlabeled'
  FROM public.folders f
 WHERE e.folder_id = f.id
   AND f.gmail_label_id IS NOT NULL
   AND NOT (COALESCE(e.raw_labels, '{}') @> ARRAY[f.gmail_label_id]);