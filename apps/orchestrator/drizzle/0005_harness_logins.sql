-- When each harness last found a login in the agent's home, by harness: {"claude-code": "<iso time>"}.
ALTER TABLE public.agents ADD COLUMN harness_logins jsonb NOT NULL DEFAULT '{}'::jsonb;
