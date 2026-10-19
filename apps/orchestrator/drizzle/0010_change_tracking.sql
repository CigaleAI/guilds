-- The coach message an applied Studio edit came from.
ALTER TABLE public.file_changes ADD COLUMN studio_session_id text;
--> statement-breakpoint
ALTER TABLE public.file_changes ADD COLUMN studio_seq integer;
--> statement-breakpoint
ALTER TABLE public.file_changes ADD CONSTRAINT file_changes_studio_session_id_fkey FOREIGN KEY (studio_session_id) REFERENCES public.studio_sessions(id) ON DELETE SET NULL;
--> statement-breakpoint
-- One row per change to a routine, an access setting, a guild's text, or a table's shape or records as a whole.
CREATE TABLE public.config_changes (
	id text PRIMARY KEY,
	org_id text NOT NULL,
	guild_id text,
	agent_id text,
	target_kind text NOT NULL,
	target_id text NOT NULL,
	operation text NOT NULL,
	summary text NOT NULL,
	actor_type text NOT NULL,
	actor_id text NOT NULL,
	actor_name text NOT NULL,
	run_id text,
	tool_call_id text,
	tool_name text,
	studio_session_id text,
	studio_seq integer,
	created_at timestamp with time zone NOT NULL,
	CONSTRAINT config_changes_target_kind_check CHECK (target_kind IN ('routine', 'access', 'guild_text', 'collection')),
	CONSTRAINT config_changes_operation_check CHECK (operation IN ('create', 'update', 'delete')),
	CONSTRAINT config_changes_actor_type_check CHECK (actor_type IN ('user', 'agent', 'run'))
);
--> statement-breakpoint
ALTER TABLE public.config_changes ADD CONSTRAINT config_changes_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE public.config_changes ADD CONSTRAINT config_changes_guild_id_fkey FOREIGN KEY (guild_id) REFERENCES public.guilds(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE public.config_changes ADD CONSTRAINT config_changes_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE public.config_changes ADD CONSTRAINT config_changes_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE public.config_changes ADD CONSTRAINT config_changes_studio_session_id_fkey FOREIGN KEY (studio_session_id) REFERENCES public.studio_sessions(id) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX config_changes_by_target ON public.config_changes USING btree (org_id, target_kind, target_id, created_at);
--> statement-breakpoint
CREATE INDEX config_changes_by_guild ON public.config_changes USING btree (guild_id, created_at);
--> statement-breakpoint
-- What started a run: the public post that woke a group run, or the person who opened a direct one.
ALTER TABLE public.runs ADD COLUMN wake_group_message_id bigint;
--> statement-breakpoint
ALTER TABLE public.runs ADD COLUMN started_by_user_id text;
--> statement-breakpoint
ALTER TABLE public.runs ADD CONSTRAINT runs_wake_group_message_id_fkey FOREIGN KEY (wake_group_message_id) REFERENCES public.group_messages(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE public.runs ADD CONSTRAINT runs_started_by_user_id_fkey FOREIGN KEY (started_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;
--> statement-breakpoint
-- The person who posted an operator row in group chat.
ALTER TABLE public.group_messages ADD COLUMN author_user_id text;
--> statement-breakpoint
ALTER TABLE public.group_messages ADD CONSTRAINT group_messages_author_user_id_fkey FOREIGN KEY (author_user_id) REFERENCES public.users(id) ON DELETE SET NULL;
--> statement-breakpoint
-- The person who discarded a Studio draft.
ALTER TABLE public.studio_drafts ADD COLUMN discarded_by_user_id text;
--> statement-breakpoint
ALTER TABLE public.studio_drafts ADD CONSTRAINT studio_drafts_discarded_by_user_id_fkey FOREIGN KEY (discarded_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;
