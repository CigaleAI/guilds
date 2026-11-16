-- How a repository's token is minted: `github` through the GitHub login `connection_id` names,
-- `access_token` from the secret `secret_id` names, sent with `username`. A repository with no
-- provider is cloned without credentials. Every repository with a GitHub login takes `github`.
ALTER TABLE public.guild_repositories ADD COLUMN provider text;
--> statement-breakpoint
ALTER TABLE public.guild_repositories ADD COLUMN secret_id text;
--> statement-breakpoint
ALTER TABLE public.guild_repositories ADD COLUMN username text;
--> statement-breakpoint
UPDATE public.guild_repositories SET provider = 'github' WHERE connection_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE public.guild_repositories ADD CONSTRAINT guild_repositories_provider_check CHECK (provider IN ('github', 'access_token'));
--> statement-breakpoint
ALTER TABLE public.guild_repositories ADD CONSTRAINT guild_repositories_credential_check CHECK (
  CASE provider
    WHEN 'github' THEN connection_id IS NOT NULL AND secret_id IS NULL AND username IS NULL
    WHEN 'access_token' THEN connection_id IS NULL AND secret_id IS NOT NULL AND username IS NOT NULL
    ELSE connection_id IS NULL AND secret_id IS NULL AND username IS NULL
  END
);
--> statement-breakpoint
ALTER TABLE public.guild_repositories ADD CONSTRAINT guild_repositories_secret_id_fkey FOREIGN KEY (secret_id) REFERENCES public.secrets(id) ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX guild_repositories_by_secret ON public.guild_repositories USING btree (secret_id);
