-- Every agent config and every run snapshot holds `max_wake_ups`: one that predates it takes the default.
UPDATE public.agents
   SET config = jsonb_build_object('max_wake_ups', 10) || config
 WHERE NOT config ? 'max_wake_ups';
--> statement-breakpoint
UPDATE public.runs
   SET config_snapshot = jsonb_build_object('max_wake_ups', 10) || config_snapshot
 WHERE NOT config_snapshot ? 'max_wake_ups';
