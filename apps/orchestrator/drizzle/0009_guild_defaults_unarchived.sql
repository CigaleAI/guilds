-- A new guild lets its agents post as many group chat messages per run as the app's default.
ALTER TABLE public.guilds ALTER COLUMN group_agent_message_limit SET DEFAULT 200;
--> statement-breakpoint
-- Guilds, agents, and runs are deleted, never archived.
ALTER TABLE public.guilds DROP COLUMN archived_at;
--> statement-breakpoint
ALTER TABLE public.agents DROP COLUMN archived_at;
--> statement-breakpoint
ALTER TABLE public.runs DROP COLUMN archived_at;
