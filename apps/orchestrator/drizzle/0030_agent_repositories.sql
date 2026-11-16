-- Every agent config holds `repositories`, the repositories its coding runs clone, by name. A
-- coding agent keeps the ones it cloned before: those picked on the GitHub login it clones with
-- (its own, else its guild's, else its organisation's, while connected), in the login's order,
-- then its guild's other repositories by name. Any other agent picks none.
WITH login AS (
  SELECT DISTINCT ON (a.id) a.id AS agent_id,
         CASE WHEN jsonb_typeof(c.settings->'repositories') = 'array' THEN c.settings->'repositories' ELSE '[]'::jsonb END AS picks
    FROM public.agents a
    JOIN public.mcp_connections c
      ON c.mcp_server_id = 'mcp_github' AND c.status = 'connected'
     AND ((c.owner_scope = 'agent' AND c.owner_id = a.id)
       OR (c.owner_scope = 'guild' AND c.owner_id = a.guild_id)
       OR (c.owner_scope = 'org' AND c.owner_id = a.org_id))
   WHERE a.config->'coding' = 'true'::jsonb
   ORDER BY a.id, CASE c.owner_scope WHEN 'agent' THEN 0 WHEN 'guild' THEN 1 ELSE 2 END
),
picked AS (
  SELECT l.agent_id, pick.value->>'name' AS name, pick.position
    FROM login l
   CROSS JOIN LATERAL jsonb_array_elements(l.picks) WITH ORDINALITY AS pick(value, position)
   WHERE pick.value->>'name' IS NOT NULL
),
cloned AS (
  SELECT p.agent_id, p.name, 0 AS rank, p.position, '' AS sort_name
    FROM picked p
  UNION ALL
  SELECT a.id, r.name, 1, 0, r.name
    FROM public.agents a
    JOIN public.guild_repositories r ON r.guild_id = a.guild_id
   WHERE a.config->'coding' = 'true'::jsonb
     AND NOT EXISTS (SELECT 1 FROM picked p WHERE p.agent_id = a.id AND p.name = r.name)
),
lists AS (
  SELECT agent_id, jsonb_agg(name ORDER BY rank, position, sort_name) AS repositories
    FROM cloned
   GROUP BY agent_id
)
UPDATE public.agents a
   SET config = jsonb_build_object('repositories', l.repositories) || a.config
  FROM lists l
 WHERE a.id = l.agent_id AND NOT a.config ? 'repositories';
--> statement-breakpoint
UPDATE public.agents
   SET config = jsonb_build_object('repositories', '[]'::jsonb) || config
 WHERE NOT config ? 'repositories';
