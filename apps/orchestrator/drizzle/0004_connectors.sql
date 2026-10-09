-- Installed connectors become documents: one row per connector with its manifest as JSON, beside
-- the box's state for it (enabled, the registered OAuth client, admin overrides). The publish
-- workflow's catalog tools go away; a server's tools are its manifest's and its logins' listings.
CREATE TABLE public.connectors (
    id text NOT NULL,
    slug text NOT NULL,
    tool_prefix text NOT NULL,
    owner_org_id text,
    manifest jsonb NOT NULL,
    source text NOT NULL,
    version text DEFAULT ''::text NOT NULL,
    verified boolean DEFAULT false NOT NULL,
    publisher text DEFAULT ''::text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    oauth_client jsonb,
    overrides jsonb DEFAULT '{}'::jsonb NOT NULL,
    installed_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT connectors_pkey PRIMARY KEY (id),
    CONSTRAINT connectors_source_check CHECK ((source = ANY (ARRAY['core'::text, 'registry'::text, 'local'::text]))),
    CONSTRAINT connectors_owner_org_id_fkey FOREIGN KEY (owner_org_id) REFERENCES public.orgs(id) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO public.connectors (
    id, slug, tool_prefix, owner_org_id, manifest, source, version, verified, publisher, enabled,
    oauth_client, overrides, installed_at, updated_at
)
SELECT
    s.id,
    replace(s.slug, '-', '_'),
    s.tool_prefix,
    NULL,
    jsonb_strip_nulls(jsonb_build_object(
        'slug', replace(s.slug, '-', '_'),
        'display_name', s.display_name,
        'endpoint', CASE WHEN COALESCE(s.config->>'url', '') <> '' THEN jsonb_build_object('url', s.config->>'url') END,
        'auth', jsonb_strip_nulls(jsonb_build_object(
            'kind', s.auth,
            'oauth', CASE WHEN s.auth = 'oauth' THEN jsonb_build_object(
                'strategy', CASE WHEN s.oauth_strategy = 'configured' THEN 'configured' ELSE 'dynamic' END
            ) END
        )),
        'description', s.description,
        'limitations', s.limitations,
        'setup_hint', s.setup_hint,
        'tools', (
            SELECT jsonb_agg(jsonb_build_object(
                'name', t.remote_name,
                'description', t.description,
                'input_schema', t.input_schema
            ) ORDER BY t.remote_name)
            FROM public.mcp_catalog_tools t
            WHERE t.mcp_server_id = s.id AND t.source IN ('manifest', 'admin')
        )
    )),
    CASE WHEN c.id IS NULL THEN 'local' ELSE 'core' END,
    '',
    c.id IS NOT NULL,
    CASE WHEN c.id IS NULL THEN '' ELSE 'guilds' END,
    s.publication_state <> 'disabled',
    s.config->'oauth_client',
    jsonb_strip_nulls(jsonb_build_object(
        'display_name', CASE WHEN c.id IS NOT NULL AND s.copy_source = 'admin' THEN s.display_name END,
        'description', CASE WHEN c.id IS NOT NULL AND s.copy_source = 'admin' THEN s.description END,
        'limitations', CASE WHEN c.id IS NOT NULL AND s.copy_source = 'admin' THEN s.limitations END,
        'setup_hint', CASE WHEN c.id IS NOT NULL AND s.copy_source = 'admin' THEN s.setup_hint END,
        'tools', (
            SELECT jsonb_object_agg(t.remote_name, jsonb_strip_nulls(jsonb_build_object(
                'description', CASE WHEN c.id IS NOT NULL AND t.source = 'admin' THEN t.description END,
                'input_schema', CASE WHEN c.id IS NOT NULL AND t.source = 'admin' THEN t.input_schema END,
                'default', t.default_enabled
            )))
            FROM public.mcp_catalog_tools t
            WHERE t.mcp_server_id = s.id
              AND (
                  t.source = 'admin'
                  OR (t.source = 'runtime_candidate' AND t.default_enabled)
              )
        )
    )),
    s.created_at,
    s.updated_at
FROM public.mcp_servers s
-- Core's connectors when this migration was written; boot re-projects each from its folder.
LEFT JOIN (VALUES
    ('mcp_notion'), ('mcp_gmail'), ('mcp_drive'), ('mcp_sentry'), ('mcp_github'), ('mcp_cigale'),
    ('mcp_coingecko'), ('mcp_pinned_prices'), ('mcp_wallet'), ('mcp_alchemy'), ('mcp_opensea'),
    ('mcp_etherscan'), ('mcp_x'), ('mcp_twitterapiio'), ('mcp_qonto'), ('mcp_dexpaprika')
) AS c(id) ON c.id = s.id;
--> statement-breakpoint
ALTER TABLE public.mcp_tools DROP CONSTRAINT mcp_tools_catalog_server_fkey;
--> statement-breakpoint
ALTER TABLE public.mcp_tools DROP COLUMN catalog_tool_id;
--> statement-breakpoint
DROP TABLE public.mcp_catalog_tools;
--> statement-breakpoint
ALTER TABLE public.mcp_connections DROP CONSTRAINT mcp_connections_mcp_server_id_fkey;
--> statement-breakpoint
ALTER TABLE public.mcp_connections
    ADD CONSTRAINT mcp_connections_mcp_server_id_fkey FOREIGN KEY (mcp_server_id) REFERENCES public.connectors(id) ON DELETE CASCADE;
--> statement-breakpoint
DROP TABLE public.mcp_servers;
--> statement-breakpoint
CREATE UNIQUE INDEX connectors_tool_prefix_key ON public.connectors USING btree (tool_prefix);
--> statement-breakpoint
CREATE UNIQUE INDEX connectors_platform_slug_key ON public.connectors USING btree (slug) WHERE (owner_org_id IS NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX connectors_org_slug_key ON public.connectors USING btree (owner_org_id, slug) WHERE (owner_org_id IS NOT NULL);
