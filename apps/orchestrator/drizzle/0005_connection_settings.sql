-- What a login stores beside its credentials becomes one document its connector's manifest
-- describes: pinned coins and picked repositories move into it, and their columns go away. A
-- Drive login's folder moves out of the encrypted payload at boot, where the key is at hand.
ALTER TABLE public.mcp_connections ADD COLUMN settings jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
UPDATE public.mcp_connections
SET settings = jsonb_strip_nulls(jsonb_build_object(
    'coins', CASE WHEN jsonb_array_length(pinned_prices) > 0 THEN pinned_prices END,
    'repositories', CASE WHEN jsonb_array_length(github_repositories) > 0 THEN github_repositories END
));
--> statement-breakpoint
ALTER TABLE public.mcp_connections DROP COLUMN pinned_prices;
--> statement-breakpoint
ALTER TABLE public.mcp_connections DROP COLUMN github_repositories;
