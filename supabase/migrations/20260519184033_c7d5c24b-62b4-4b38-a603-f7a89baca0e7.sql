
-- Replace permissive auth_all_* policies with per-user policies

-- emails
DROP POLICY IF EXISTS auth_all_emails ON public.emails;
CREATE POLICY "Users access own emails" ON public.emails
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- folders
DROP POLICY IF EXISTS auth_all_folders ON public.folders;
CREATE POLICY "Users access own folders" ON public.folders
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- folder_examples
DROP POLICY IF EXISTS auth_all_folder_examples ON public.folder_examples;
CREATE POLICY "Users access own folder examples" ON public.folder_examples
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- folder_filters — no user_id column; scope via parent folder
DROP POLICY IF EXISTS auth_all_filters ON public.folder_filters;
CREATE POLICY "Users access own folder filters" ON public.folder_filters
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.folders f WHERE f.id = folder_filters.folder_id AND f.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.folders f WHERE f.id = folder_filters.folder_id AND f.user_id = auth.uid()));

-- reply_drafts
DROP POLICY IF EXISTS auth_all_drafts ON public.reply_drafts;
CREATE POLICY "Users access own reply drafts" ON public.reply_drafts
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- sync_state — legacy table; lock it down (no longer used by app code after this migration)
DROP POLICY IF EXISTS auth_all_sync ON public.sync_state;
CREATE POLICY "Users access own sync state" ON public.sync_state
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
