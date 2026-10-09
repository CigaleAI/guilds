-- A guild repository records GitHub's id for it, which survives a rename of the repository or
-- its owner, and goes with the GitHub login it was picked through.
ALTER TABLE public.guild_repositories ADD COLUMN github_id bigint;
--> statement-breakpoint
ALTER TABLE public.guild_repositories DROP CONSTRAINT guild_repositories_connection_id_fkey;
--> statement-breakpoint
ALTER TABLE public.guild_repositories
    ADD CONSTRAINT guild_repositories_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES public.mcp_connections(id) ON DELETE CASCADE;
