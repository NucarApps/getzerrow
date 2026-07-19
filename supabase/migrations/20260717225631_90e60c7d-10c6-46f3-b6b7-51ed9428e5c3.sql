
ALTER POLICY "Users manage their own carddav settings" ON public.carddav_settings TO authenticated;
ALTER POLICY "Users manage their own carddav tokens" ON public.carddav_tokens TO authenticated;
ALTER POLICY "Users manage their own carddav tombstones" ON public.carddav_tombstones TO authenticated;
ALTER POLICY "Users access own contact group members" ON public.contact_group_members TO authenticated;
ALTER POLICY "Users manage their own folder chat messages" ON public.folder_chat_messages TO authenticated;
ALTER POLICY "Users manage their own folder chat state" ON public.folder_chat_state TO authenticated;
ALTER POLICY "Users read their google contact links" ON public.google_contact_links TO authenticated;
ALTER POLICY "Users read their google tombstones" ON public.google_contact_tombstones TO authenticated;
ALTER POLICY "Users read their google group links" ON public.google_group_links TO authenticated;
ALTER POLICY "Users read their google sync state" ON public.google_sync_state TO authenticated;
ALTER POLICY "Users manage their own meetings" ON public.meetings TO authenticated;
ALTER POLICY "Users manage own task suggestions" ON public.task_completion_suggestions TO authenticated;
ALTER POLICY "Users insert own extraction runs" ON public.task_extraction_runs TO authenticated;
ALTER POLICY "Users read own extraction runs" ON public.task_extraction_runs TO authenticated;
ALTER POLICY "Users manage own tasks" ON public.tasks TO authenticated;
