-- Usage counters and monthly usage count what browse calls spent, apart from model calls.
ALTER TABLE public.usage_counters ADD COLUMN browser_input_tokens bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE public.usage_counters ADD COLUMN browser_output_tokens bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE public.usage_counters ADD COLUMN browser_cost_usd numeric NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE public.usage_counters ADD COLUMN browser_calls bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE public.org_monthly_usage ADD COLUMN browser_input_tokens bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE public.org_monthly_usage ADD COLUMN browser_output_tokens bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE public.org_monthly_usage ADD COLUMN browser_cost_usd numeric NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE public.org_monthly_usage ADD COLUMN browser_calls bigint NOT NULL DEFAULT 0;
