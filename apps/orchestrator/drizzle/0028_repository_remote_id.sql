-- A repository's id on its host, which a rename of it or its owner keeps: on a guild's repository
-- and on each repository a login picked.
ALTER TABLE public.guild_repositories RENAME COLUMN github_id TO remote_id;
--> statement-breakpoint
UPDATE public.mcp_connections
   SET settings = jsonb_set(
         settings,
         '{repositories}',
         (SELECT COALESCE(
                   jsonb_agg(
                     CASE WHEN item ? 'github_id'
                          THEN (item - 'github_id') || jsonb_build_object('remote_id', item->'github_id')
                          ELSE item END
                     ORDER BY position),
                   '[]'::jsonb)
            FROM jsonb_array_elements(settings->'repositories') WITH ORDINALITY AS listed(item, position)))
 WHERE jsonb_typeof(settings->'repositories') = 'array';
