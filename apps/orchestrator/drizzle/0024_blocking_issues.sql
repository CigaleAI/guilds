-- An issue's severity may be `blocking`: while one is open, the agent that reported it starts no generation.
ALTER TABLE public.guild_issues DROP CONSTRAINT guild_issues_severity_check;
--> statement-breakpoint
ALTER TABLE public.guild_issues ADD CONSTRAINT guild_issues_severity_check CHECK ((severity = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text, 'blocking'::text])));
--> statement-breakpoint
CREATE INDEX guild_issues_open_blocking ON public.guild_issues USING btree (agent_id) WHERE ((status = 'open'::text) AND (severity = 'blocking'::text));
