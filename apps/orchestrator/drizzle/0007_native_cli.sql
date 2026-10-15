-- Every agent has the CLI tab: the `cli` flag leaves agent configs, active run snapshots, and recipe roles.
UPDATE public.agents SET config = config - 'cli' WHERE config ? 'cli';
--> statement-breakpoint
UPDATE public.runs
   SET config_snapshot = config_snapshot - 'cli'
 WHERE status = 'active' AND archived_at IS NULL AND config_snapshot ? 'cli';
--> statement-breakpoint
UPDATE public.recipes
   SET body = jsonb_set(
	body,
	'{roles}',
	(
		SELECT jsonb_agg(
			CASE WHEN jsonb_typeof(role->'config') = 'object'
				THEN jsonb_set(role, '{config}', (role->'config') - 'cli')
				ELSE role
			END
			ORDER BY position
		)
		  FROM jsonb_array_elements(body->'roles') WITH ORDINALITY AS roles(role, position)
	)
 )
 WHERE jsonb_typeof(body->'roles') = 'array'
   AND jsonb_array_length(body->'roles') > 0
   AND EXISTS (
	SELECT 1 FROM jsonb_array_elements(body->'roles') AS roles(role) WHERE role->'config' ? 'cli'
   );
