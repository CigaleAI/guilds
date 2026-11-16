-- Kimi Code is not a model provider: the organisations' Kimi Code keys and chosen models go. An
-- agent on a `kimi/` model keeps the id and runs once its operator picks a model of a connected
-- provider.
DELETE FROM public.org_model_providers WHERE provider = 'kimi';
--> statement-breakpoint
UPDATE public.orgs SET default_model = NULL WHERE default_model LIKE 'kimi/%';
