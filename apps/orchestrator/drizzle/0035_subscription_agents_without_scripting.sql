-- A subscription agent has no scripting: its harness runs commands and code with its own tools.
UPDATE public.agents
   SET config = config || jsonb_build_object('scripting', false)
 WHERE jsonb_typeof(config->'harness') = 'string'
   AND config->'scripting' IS DISTINCT FROM 'false'::jsonb;
