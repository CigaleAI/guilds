-- Calls on platform-owned logins are counted per organisation, per connector, per month, so an
-- edition can cap them. Web search becomes the Tavily connector's `search` tool, still named
-- `tavily_search`: its native-tool bindings become tool bindings, keeping scope and switch.
CREATE TABLE public.connector_calls (
    org_id text NOT NULL,
    connector_id text NOT NULL,
    month text NOT NULL,
    calls integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT connector_calls_pkey PRIMARY KEY (org_id, connector_id, month),
    CONSTRAINT connector_calls_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE,
    CONSTRAINT connector_calls_connector_id_fkey FOREIGN KEY (connector_id) REFERENCES public.connectors(id) ON DELETE CASCADE
);
--> statement-breakpoint
UPDATE public.bindings
SET catalog_kind = 'mcp_tool'
WHERE catalog_kind = 'native_tool' AND catalog_id = 'tavily_search';
