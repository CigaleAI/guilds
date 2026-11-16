-- A coding agent becomes a subscription agent: it keeps its harness, harness model and effort, and
-- repositories, loses its lead model, and its model-loop settings take their defaults, which a
-- subscription agent holds. A coding agent with no harness picked keeps its lead model as an agent
-- on a key, which works on no repositories. Every agent config loses `coding`.
UPDATE public.agents
   SET config = (config - 'coding') || jsonb_build_object(
         'model', NULL::text,
         'temperature', 1,
         'thinking_level', 'none',
         'max_tokens', 8192,
         'max_input_tokens', 100000,
         'keep_tool_result_generations', NULL::int)
 WHERE config->'coding' = 'true'::jsonb
   AND jsonb_typeof(config->'harness') = 'string';
--> statement-breakpoint
UPDATE public.agents
   SET config = (config - 'coding') || jsonb_build_object('repositories', '[]'::jsonb)
 WHERE config->'coding' = 'true'::jsonb;
--> statement-breakpoint
UPDATE public.agents SET config = config - 'coding' WHERE config ? 'coding';
--> statement-breakpoint
-- A run keeps the model it ran on; its snapshot loses `coding`, and its metadata the chain it sat
-- in and the repositories a coding run changed.
UPDATE public.runs SET config_snapshot = config_snapshot - 'coding' WHERE config_snapshot ? 'coding';
--> statement-breakpoint
UPDATE public.runs
   SET metadata = metadata - ARRAY['chain', 'continued_by_run_id', 'repos', 'harness_task']
 WHERE metadata ?| ARRAY['chain', 'continued_by_run_id', 'repos', 'harness_task'];
--> statement-breakpoint
-- A message of a run keeps its text: a result of a removed code tool loses the fields the tool
-- reported, and a message that continued or handed off a chain reads as a system message.
UPDATE public.messages
   SET metadata = metadata - ARRAY[
         'repeat_of', 'cwd', 'path', 'range', 'content_hash', 'lines', 'log_path', 'timed_out',
         'background_id', 'state', 'matches', 'files', 'harness', 'session_id', 'repository',
         'files_changed', 'insertions', 'deletions', 'start_sha', 'end_sha']
 WHERE metadata->>'tool_name' IN ('code_task', 'shell', 'shell_status', 'file_read', 'code_search');
--> statement-breakpoint
UPDATE public.messages
   SET metadata = (metadata - 'previous_run_id') || jsonb_build_object('source', 'system')
 WHERE metadata->>'source' IN ('continuation', 'handoff');
--> statement-breakpoint
DROP INDEX public.run_wakes_by_root;
--> statement-breakpoint
ALTER TABLE public.run_wakes DROP COLUMN root_run_id;
--> statement-breakpoint
CREATE INDEX run_wakes_by_run ON public.run_wakes USING btree (run_id, state);
--> statement-breakpoint
-- A recipe's coding role becomes a subscription role on the harness it names, without its model
-- and its model-loop settings; one that names no harness keeps its model, as a role on a key that
-- works on no repositories. Every role's config loses `coding`.
UPDATE public.recipes r
   SET body = jsonb_set(r.body, '{roles}', (
         SELECT jsonb_agg(
                  CASE
                    WHEN role->'config'->'coding' = 'true'::jsonb AND jsonb_typeof(role->'config'->'harness') = 'string'
                      THEN jsonb_set(role, '{config}', (role->'config') - ARRAY[
                             'coding', 'model', 'temperature', 'thinking_level', 'max_tokens',
                             'max_input_tokens', 'keep_tool_result_generations'])
                    WHEN role->'config'->'coding' = 'true'::jsonb
                      THEN jsonb_set(role, '{config}', (role->'config') - ARRAY['coding', 'repositories'])
                    WHEN role->'config' ? 'coding'
                      THEN jsonb_set(role, '{config}', (role->'config') - 'coding')
                    ELSE role
                  END ORDER BY position)
           FROM jsonb_array_elements(r.body->'roles') WITH ORDINALITY AS item(role, position)))
 WHERE jsonb_typeof(r.body->'roles') = 'array'
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(r.body->'roles') AS item(role) WHERE role->'config' ? 'coding');
--> statement-breakpoint
-- An apply's preview loses each agent's coding flag and each harness's subscription flag.
UPDATE public.recipe_applies a
   SET preview = jsonb_set(jsonb_set(a.preview,
         '{creates,agents}', COALESCE((SELECT jsonb_agg(agent - 'coding' ORDER BY position)
                                         FROM jsonb_array_elements(a.preview->'creates'->'agents') WITH ORDINALITY AS item(agent, position)), '[]'::jsonb)),
         '{harnesses}', COALESCE((SELECT jsonb_agg(harness - 'subscription' ORDER BY position)
                                    FROM jsonb_array_elements(a.preview->'harnesses') WITH ORDINALITY AS item(harness, position)), '[]'::jsonb))
 WHERE jsonb_typeof(a.preview->'creates'->'agents') = 'array'
   AND jsonb_typeof(a.preview->'harnesses') = 'array';
