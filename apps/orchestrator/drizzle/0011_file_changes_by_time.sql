-- An organisation's changes over a window, for Studio's State list.
CREATE INDEX file_changes_by_org_time ON public.file_changes USING btree (org_id, created_at);
