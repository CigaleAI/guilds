-- Every agent config holds `read_only_repositories`, the repositories of its `repositories` it only
-- reads; a config that predates it holds an empty list.
UPDATE public.agents
   SET config = jsonb_build_object('read_only_repositories', '[]'::jsonb) || config
 WHERE NOT config ? 'read_only_repositories';
