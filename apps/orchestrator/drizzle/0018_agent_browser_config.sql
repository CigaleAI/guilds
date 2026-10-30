-- Every agent config holds the browser mode keys: a config that predates them browses with the step-by-step browser tools.
UPDATE public.agents
   SET config = jsonb_build_object(
         'browser_optimized', false,
         'browser_model', NULL
       ) || config
 WHERE NOT config ?& ARRAY['browser_optimized', 'browser_model'];
