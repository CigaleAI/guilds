ALTER TABLE public.org_model_providers DROP CONSTRAINT org_model_providers_provider_check;
--> statement-breakpoint
ALTER TABLE public.org_model_providers ALTER COLUMN ciphertext DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE public.org_model_providers ALTER COLUMN nonce DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE public.org_model_providers ALTER COLUMN key_hint DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE public.org_model_providers ADD COLUMN models text[] DEFAULT '{}'::text[] NOT NULL;
--> statement-breakpoint
ALTER TABLE public.orgs ADD COLUMN default_model text;
