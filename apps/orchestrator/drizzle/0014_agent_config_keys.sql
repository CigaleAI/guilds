-- Every agent config holds every key: a key a config predates takes the value a config without it read as.
UPDATE public.agents
   SET config = jsonb_build_object(
         'temperature', 1,
         'max_tokens', 8192,
         'max_steps', 30,
         'max_tool_calls', 50,
         'max_input_tokens', 100000,
         'keep_tool_result_generations', 1,
         'max_scripts', 10,
         'max_workspace_mib', 10240,
         'browser', false,
         'browser_language', 'en-US',
         'coding', false,
         'harness', NULL,
         'harness_model', NULL,
         'harness_effort', NULL,
         'secret_aliases', '{}'::jsonb,
         'scripting', true,
         'memory', true,
         'thinking_level', 'none'
       ) || config
 WHERE NOT config ?& ARRAY[
         'temperature', 'max_tokens', 'max_steps', 'max_tool_calls', 'max_input_tokens',
         'keep_tool_result_generations', 'max_scripts', 'max_workspace_mib', 'browser',
         'browser_language', 'coding', 'harness', 'harness_model', 'harness_effort',
         'secret_aliases', 'scripting', 'memory', 'thinking_level'
       ];
