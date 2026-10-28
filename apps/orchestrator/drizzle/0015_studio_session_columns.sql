-- A Studio session always records its source guild, and no session names a coach agent of its own.
ALTER TABLE public.studio_sessions ALTER COLUMN source_guild_snapshot DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE public.studio_sessions DROP COLUMN coach_snapshot;
--> statement-breakpoint
ALTER TABLE public.studio_sessions DROP COLUMN coach_agent_id;
