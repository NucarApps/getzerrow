-- 1. card_events: deny authenticated inserts (server-only writes via service role)
CREATE POLICY "Block client card_events inserts"
ON public.card_events
FOR INSERT
TO authenticated
WITH CHECK (false);

-- 2. sync_state: require user_id
ALTER TABLE public.sync_state
  ALTER COLUMN user_id SET NOT NULL;

-- 3. folder_filters: cap regex pattern length to bound RegExp evaluation cost
ALTER TABLE public.folder_filters
  ADD CONSTRAINT folder_filters_regex_value_len_chk
  CHECK (op <> 'regex' OR char_length(value) <= 200);

-- 4. card-images: drop the broad public SELECT policy that enables listing.
-- Public bucket files remain accessible via their direct CDN URLs without an RLS policy.
DROP POLICY IF EXISTS "Card images are publicly readable" ON storage.objects;