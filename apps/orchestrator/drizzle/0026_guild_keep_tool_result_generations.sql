-- A guild sets `keep_tool_result_generations` for its agents whose config sets none. A guild that
-- predates it keeps 1, the default its agents had; a guild created after it starts at 2. Every
-- agent config already holds its own value, so every existing agent keeps it as its own.
ALTER TABLE public.guilds ADD COLUMN keep_tool_result_generations integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE public.guilds ALTER COLUMN keep_tool_result_generations SET DEFAULT 2;
--> statement-breakpoint
ALTER TABLE public.guilds ADD CONSTRAINT guilds_keep_tool_result_generations_positive CHECK (keep_tool_result_generations > 0);
