-- Every agent config and every run snapshot holds `max_turn_minutes`: one that predates it takes the default.
UPDATE public.agents
   SET config = jsonb_build_object('max_turn_minutes', 30) || config
 WHERE NOT config ? 'max_turn_minutes';
--> statement-breakpoint
UPDATE public.runs
   SET config_snapshot = jsonb_build_object('max_turn_minutes', 30) || config_snapshot
 WHERE NOT config_snapshot ? 'max_turn_minutes';
