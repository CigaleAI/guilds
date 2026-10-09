-- Drizzle migration 0001. Core's schema snapshot.
-- Generated from a fully migrated empty database. See 0001.notes.md.

--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
--> statement-breakpoint

--
-- Name: EXTENSION pg_trgm; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';
--> statement-breakpoint

SET default_tablespace = '';
--> statement-breakpoint

SET default_table_access_method = heap;
--> statement-breakpoint

--
-- Name: agents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agents (
    id text NOT NULL,
    guild_id text NOT NULL,
    name text NOT NULL,
    config jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    archived_at timestamp with time zone,
    group_chat_delivered_through bigint DEFAULT 0 NOT NULL,
    focus text DEFAULT ''::text NOT NULL,
    avatar_shape text DEFAULT 'teardrop'::text NOT NULL,
    avatar_color text DEFAULT '#7c5cff'::text NOT NULL,
    org_id text NOT NULL,
    task text NOT NULL,
    task_version integer DEFAULT 1 NOT NULL,
    task_hash text NOT NULL,
    task_updated_at timestamp with time zone NOT NULL,
    wake_triggers text DEFAULT ''::text NOT NULL,
    workspace_mib integer
);
--> statement-breakpoint

--
-- Name: artifact_collections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.artifact_collections (
    id text NOT NULL,
    org_id text NOT NULL,
    name text NOT NULL,
    purpose text NOT NULL,
    created_by_type text NOT NULL,
    created_by_id text NOT NULL,
    created_by_name text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    deleted_at timestamp with time zone,
    columns json DEFAULT '[]'::json NOT NULL,
    next_id integer DEFAULT 1 NOT NULL,
    guild_id text,
    CONSTRAINT artifact_collections_columns_array CHECK ((json_typeof(columns) = 'array'::text)),
    CONSTRAINT artifact_collections_name_format CHECK ((name ~ '^[a-z][a-z0-9_-]{0,62}$'::text)),
    CONSTRAINT artifact_collections_purpose_len CHECK (((char_length(purpose) >= 1) AND (char_length(purpose) <= 400)))
);
--> statement-breakpoint

--
-- Name: artifacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.artifacts (
    id text NOT NULL,
    org_id text NOT NULL,
    level text NOT NULL,
    owner_id text NOT NULL,
    guild_id text,
    agent_id text,
    origin_guild_id text,
    kind text NOT NULL,
    collection_id text,
    path text DEFAULT ''::text NOT NULL,
    key text NOT NULL,
    title text,
    content_text text,
    content_json jsonb,
    search_text text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    content_hash text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_by_type text NOT NULL,
    created_by_id text NOT NULL,
    created_by_name text NOT NULL,
    updated_by_type text NOT NULL,
    updated_by_id text NOT NULL,
    updated_by_name text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    deleted_at timestamp with time zone,
    search_blob text,
    search_document tsvector GENERATED ALWAYS AS (
CASE
    WHEN (kind = ANY (ARRAY['note'::text, 'memory'::text])) THEN to_tsvector('simple'::regconfig, COALESCE(content_text, ''::text))
    WHEN (kind = 'object'::text) THEN (setweight(to_tsvector('simple'::regconfig, COALESCE(search_text, ''::text)), 'A'::"char") || setweight(to_tsvector('simple'::regconfig, COALESCE(search_blob, ''::text)), 'B'::"char"))
    ELSE NULL::tsvector
END) STORED,
    identity text,
    CONSTRAINT artifacts_kind_check CHECK ((kind = ANY (ARRAY['note'::text, 'object'::text, 'memory'::text, 'script'::text]))),
    CONSTRAINT artifacts_kind_text CHECK ((((kind = ANY (ARRAY['note'::text, 'memory'::text])) AND (content_text IS NOT NULL) AND (content_json IS NULL) AND (collection_id IS NULL)) OR ((kind = 'object'::text) AND (content_json IS NOT NULL) AND (jsonb_typeof(content_json) = 'object'::text) AND (content_text IS NULL) AND (collection_id IS NOT NULL) AND (search_blob IS NOT NULL) AND ((search_text IS NULL) OR ((char_length(search_text) >= 1) AND (char_length(search_text) <= 400)))) OR ((kind = 'script'::text) AND (content_text IS NOT NULL) AND (collection_id IS NULL) AND (level = 'agent'::text) AND (path = 'scripts'::text) AND ((content_json IS NULL) OR (jsonb_typeof(content_json) = 'object'::text))))),
    CONSTRAINT artifacts_level_agent CHECK (((level <> 'agent'::text) OR ((owner_id = agent_id) AND (agent_id IS NOT NULL)))),
    CONSTRAINT artifacts_level_check CHECK ((level = ANY (ARRAY['agent'::text, 'guild'::text, 'org'::text]))),
    CONSTRAINT artifacts_level_guild CHECK (((level <> 'guild'::text) OR ((owner_id = guild_id) AND (agent_id IS NULL) AND (guild_id IS NOT NULL)))),
    CONSTRAINT artifacts_level_org CHECK (((level <> 'org'::text) OR ((owner_id = org_id) AND (guild_id IS NULL) AND (agent_id IS NULL)))),
    CONSTRAINT artifacts_note_key CHECK (((kind <> 'note'::text) OR ((key ~ '\.md$'::text) AND (key !~ '[/\\]'::text)))),
    CONSTRAINT artifacts_script_key CHECK (((kind <> 'script'::text) OR ((key ~ '^[a-z][a-z0-9_-]{0,62}$'::text) AND (key <> 'manifest'::text) AND (key = btrim(key))))),
    CONSTRAINT artifacts_task_memory CHECK (((kind <> 'memory'::text) OR ((level = 'agent'::text) AND (path = ''::text) AND (key = 'memory.md'::text)))),
    CONSTRAINT artifacts_version_positive CHECK ((version >= 1))
);
--> statement-breakpoint

--
-- Name: attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attachments (
    id text NOT NULL,
    org_id text NOT NULL,
    uploaded_by text NOT NULL,
    filename text NOT NULL,
    mime text NOT NULL,
    bytes integer NOT NULL,
    sha256 text NOT NULL,
    kind text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT attachments_bytes_check CHECK ((bytes > 0)),
    CONSTRAINT attachments_kind_check CHECK ((kind = ANY (ARRAY['image'::text, 'file'::text]))),
    CONSTRAINT attachments_mime_check CHECK ((mime = ANY (ARRAY['image/jpeg'::text, 'image/png'::text, 'image/gif'::text, 'image/webp'::text])))
);
--> statement-breakpoint

--
-- Name: bindings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bindings (
    id text NOT NULL,
    catalog_kind text NOT NULL,
    catalog_id text NOT NULL,
    scope text NOT NULL,
    scope_id text,
    guild_id text,
    agent_id text,
    enabled boolean NOT NULL,
    connection_id text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    org_id text,
    CONSTRAINT bindings_catalog_kind_check CHECK ((catalog_kind = ANY (ARRAY['native_tool'::text, 'mcp'::text, 'mcp_tool'::text, 'artifact_grant'::text]))),
    CONSTRAINT bindings_connection_only_mcp CHECK (((connection_id IS NULL) OR (catalog_kind = 'mcp'::text))),
    CONSTRAINT bindings_scope_check CHECK ((scope = ANY (ARRAY['platform'::text, 'org'::text, 'guild'::text, 'agent'::text]))),
    CONSTRAINT bindings_scope_refs CHECK ((((scope = 'platform'::text) AND (scope_id IS NULL) AND (org_id IS NULL) AND (guild_id IS NULL) AND (agent_id IS NULL)) OR ((scope = 'org'::text) AND (scope_id = org_id) AND (guild_id IS NULL) AND (agent_id IS NULL)) OR ((scope = 'guild'::text) AND (scope_id = guild_id) AND (org_id IS NULL) AND (agent_id IS NULL)) OR ((scope = 'agent'::text) AND (scope_id = agent_id) AND (org_id IS NULL) AND (guild_id IS NULL))))
);
--> statement-breakpoint

--
-- Name: builder_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.builder_messages (
    id bigint NOT NULL,
    session_id text NOT NULL,
    seq integer NOT NULL,
    generation integer NOT NULL,
    payload jsonb NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    cost_usd numeric,
    created_at timestamp with time zone NOT NULL
);
--> statement-breakpoint

--
-- Name: builder_messages_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.builder_messages ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.builder_messages_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
--> statement-breakpoint

--
-- Name: builder_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.builder_sessions (
    id text NOT NULL,
    org_id text NOT NULL,
    created_by_user_id text,
    created_by_name text NOT NULL,
    recipe_id text NOT NULL,
    config_snapshot jsonb NOT NULL,
    status text NOT NULL,
    blocked_reason text,
    generation_state text NOT NULL,
    generation_number integer DEFAULT 0 NOT NULL,
    generation_token text,
    generation_started_at timestamp with time zone,
    errors jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    archived_at timestamp with time zone,
    CONSTRAINT builder_sessions_blocked_reason_check CHECK (((blocked_reason IS NULL) OR (blocked_reason = 'input_token_limit'::text))),
    CONSTRAINT builder_sessions_generation_state_check CHECK ((generation_state = ANY (ARRAY['idle'::text, 'generating'::text, 'cancelling'::text]))),
    CONSTRAINT builder_sessions_status_check CHECK ((status = ANY (ARRAY['active'::text, 'blocked'::text, 'archived'::text])))
);
--> statement-breakpoint

--
-- Name: collection_access; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.collection_access (
    id text NOT NULL,
    org_id text NOT NULL,
    collection_id text NOT NULL,
    subject_type text NOT NULL,
    subject_id text NOT NULL,
    mode text NOT NULL,
    created_by_type text NOT NULL,
    created_by_id text NOT NULL,
    created_by_name text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT collection_access_mode_check CHECK ((mode = ANY (ARRAY['read'::text, 'write'::text, 'none'::text]))),
    CONSTRAINT collection_access_none_is_agent CHECK (((mode <> 'none'::text) OR (subject_type = 'agent'::text))),
    CONSTRAINT collection_access_subject_check CHECK ((subject_type = ANY (ARRAY['guild'::text, 'agent'::text])))
);
--> statement-breakpoint

--
-- Name: file_changes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.file_changes (
    id text NOT NULL,
    org_id text NOT NULL,
    artifact_id text,
    task_agent_id text,
    display_path text NOT NULL,
    operation text NOT NULL,
    version integer NOT NULL,
    actor_type text NOT NULL,
    actor_id text NOT NULL,
    actor_name text NOT NULL,
    run_id text,
    tool_call_id text,
    tool_name text,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT file_changes_actor_type_check CHECK ((actor_type = ANY (ARRAY['user'::text, 'agent'::text, 'run'::text]))),
    CONSTRAINT file_changes_operation_check CHECK ((operation = ANY (ARRAY['create'::text, 'update'::text, 'delete'::text]))),
    CONSTRAINT file_changes_target_check CHECK ((((artifact_id IS NOT NULL) AND (task_agent_id IS NULL)) OR ((artifact_id IS NULL) AND (task_agent_id IS NOT NULL))))
);
--> statement-breakpoint

--
-- Name: group_chat_reads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.group_chat_reads (
    guild_id text NOT NULL,
    user_id text NOT NULL,
    seen_through_seq bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone NOT NULL
);
--> statement-breakpoint

--
-- Name: group_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.group_messages (
    id bigint NOT NULL,
    guild_id text NOT NULL,
    seq bigint NOT NULL,
    author_type text NOT NULL,
    author_name text NOT NULL,
    author_agent_id text,
    source_run_id text,
    content text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    tagged_names jsonb DEFAULT '[]'::jsonb NOT NULL,
    tagged_agent_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    tagged_user_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT group_messages_author_type_check CHECK ((author_type = ANY (ARRAY['user'::text, 'agent'::text])))
);
--> statement-breakpoint

--
-- Name: group_messages_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.group_messages_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
--> statement-breakpoint

--
-- Name: group_messages_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.group_messages_id_seq OWNED BY public.group_messages.id;
--> statement-breakpoint

--
-- Name: guild_issues; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.guild_issues (
    id text NOT NULL,
    guild_id text NOT NULL,
    org_id text NOT NULL,
    agent_id text,
    agent_name text NOT NULL,
    run_id text,
    kind text NOT NULL,
    severity text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    summary text NOT NULL,
    detail text NOT NULL,
    tool_name text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    resolved_at timestamp with time zone,
    resolved_by text,
    CONSTRAINT guild_issues_kind_check CHECK ((kind = ANY (ARRAY['tool_failure'::text, 'truncated'::text, 'api'::text, 'other'::text]))),
    CONSTRAINT guild_issues_severity_check CHECK ((severity = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text]))),
    CONSTRAINT guild_issues_status_check CHECK ((status = ANY (ARRAY['open'::text, 'resolved'::text])))
);
--> statement-breakpoint

--
-- Name: guild_operators; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.guild_operators (
    org_id text NOT NULL,
    guild_id text NOT NULL,
    user_id text NOT NULL,
    role text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT guild_operators_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'operator'::text])))
);
--> statement-breakpoint

--
-- Name: guild_repositories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.guild_repositories (
    id text NOT NULL,
    guild_id text NOT NULL,
    name text NOT NULL,
    url text NOT NULL,
    default_branch text NOT NULL,
    connection_id text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT guild_repositories_name_check CHECK ((name ~ '^[a-z][a-z0-9_-]{0,62}$'::text))
);
--> statement-breakpoint

--
-- Name: guilds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.guilds (
    id text NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    archived_at timestamp with time zone,
    group_chat_seq bigint DEFAULT 0 NOT NULL,
    group_agent_message_count integer DEFAULT 0 NOT NULL,
    group_agent_message_limit integer DEFAULT 20 NOT NULL,
    group_chat_errors jsonb DEFAULT '[]'::jsonb NOT NULL,
    about text DEFAULT ''::text NOT NULL,
    org_id text NOT NULL,
    visibility text DEFAULT 'org'::text NOT NULL,
    routines_enabled boolean DEFAULT true NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    max_agents integer DEFAULT 15 NOT NULL,
    git_author_email text DEFAULT ''::text NOT NULL,
    CONSTRAINT group_agent_message_limit_positive CHECK ((group_agent_message_limit > 0)),
    CONSTRAINT guilds_max_agents_positive CHECK ((max_agents > 0)),
    CONSTRAINT guilds_visibility_check CHECK ((visibility = ANY (ARRAY['org'::text, 'private'::text])))
);
--> statement-breakpoint

--
-- Name: mcp_catalog_tools; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mcp_catalog_tools (
    id text NOT NULL,
    mcp_server_id text NOT NULL,
    remote_name text NOT NULL,
    namespaced_name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    input_schema jsonb NOT NULL,
    source text NOT NULL,
    publication_state text DEFAULT 'draft'::text NOT NULL,
    default_enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT mcp_catalog_tools_publication_state_check CHECK ((publication_state = ANY (ARRAY['draft'::text, 'published'::text, 'disabled'::text]))),
    CONSTRAINT mcp_catalog_tools_source_check CHECK ((source = ANY (ARRAY['manifest'::text, 'admin'::text, 'runtime_candidate'::text])))
);
--> statement-breakpoint

--
-- Name: mcp_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mcp_connections (
    id text NOT NULL,
    mcp_server_id text NOT NULL,
    owner_scope text NOT NULL,
    owner_id text,
    guild_id text,
    agent_id text,
    account_hint text DEFAULT ''::text NOT NULL,
    ciphertext bytea NOT NULL,
    nonce bytea NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    rotated_at timestamp with time zone NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    oauth_state text,
    org_id text,
    pinned_prices jsonb DEFAULT '[]'::jsonb NOT NULL,
    github_repositories jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT mcp_connections_owner_refs CHECK ((((owner_scope = 'platform'::text) AND (owner_id IS NULL) AND (org_id IS NULL) AND (guild_id IS NULL) AND (agent_id IS NULL)) OR ((owner_scope = 'org'::text) AND (owner_id = org_id) AND (guild_id IS NULL) AND (agent_id IS NULL)) OR ((owner_scope = 'guild'::text) AND (owner_id = guild_id) AND (org_id IS NULL) AND (agent_id IS NULL)) OR ((owner_scope = 'agent'::text) AND (owner_id = agent_id) AND (org_id IS NULL) AND (guild_id IS NULL)))),
    CONSTRAINT mcp_connections_owner_scope_check CHECK ((owner_scope = ANY (ARRAY['platform'::text, 'org'::text, 'guild'::text, 'agent'::text]))),
    CONSTRAINT mcp_connections_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'connected'::text, 'disconnected'::text])))
);
--> statement-breakpoint

--
-- Name: mcp_servers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mcp_servers (
    id text NOT NULL,
    slug text NOT NULL,
    display_name text NOT NULL,
    transport text NOT NULL,
    config jsonb NOT NULL,
    auth text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    limitations text,
    setup_hint text,
    publication_state text DEFAULT 'published'::text NOT NULL,
    tool_prefix text NOT NULL,
    oauth_strategy text DEFAULT 'none'::text NOT NULL,
    copy_source text DEFAULT 'manifest'::text NOT NULL,
    CONSTRAINT mcp_servers_auth_check CHECK ((auth = ANY (ARRAY['none'::text, 'token'::text, 'oauth'::text]))),
    CONSTRAINT mcp_servers_copy_source_check CHECK ((copy_source = ANY (ARRAY['manifest'::text, 'admin'::text]))),
    CONSTRAINT mcp_servers_oauth_strategy_check CHECK ((oauth_strategy = ANY (ARRAY['none'::text, 'dynamic'::text, 'configured'::text]))),
    CONSTRAINT mcp_servers_publication_state_check CHECK ((publication_state = ANY (ARRAY['draft'::text, 'published'::text, 'disabled'::text]))),
    CONSTRAINT mcp_servers_transport_check CHECK ((transport = ANY (ARRAY['stdio'::text, 'http'::text])))
);
--> statement-breakpoint

--
-- Name: mcp_tools; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mcp_tools (
    id text NOT NULL,
    connection_id text NOT NULL,
    remote_name text NOT NULL,
    namespaced_name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    input_schema jsonb NOT NULL,
    listed_at timestamp with time zone NOT NULL,
    mcp_server_id text NOT NULL,
    catalog_tool_id text NOT NULL
);
--> statement-breakpoint

--
-- Name: memory_revisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_revisions (
    id text NOT NULL,
    org_id text NOT NULL,
    agent_id text NOT NULL,
    content_text text NOT NULL,
    replaced_at timestamp with time zone NOT NULL,
    replaced_by_type text NOT NULL,
    replaced_by_id text NOT NULL,
    replaced_by_name text NOT NULL,
    replaced_by_detail text NOT NULL,
    created_at timestamp with time zone NOT NULL
);
--> statement-breakpoint

--
-- Name: messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messages (
    id bigint NOT NULL,
    run_id text NOT NULL,
    seq integer NOT NULL,
    payload jsonb NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    cost_usd numeric
);
--> statement-breakpoint

--
-- Name: messages_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.messages_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
--> statement-breakpoint

--
-- Name: messages_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.messages_id_seq OWNED BY public.messages.id;
--> statement-breakpoint

--
-- Name: org_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_members (
    org_id text NOT NULL,
    user_id text NOT NULL,
    role text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT org_members_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text])))
);
--> statement-breakpoint

--
-- Name: org_model_providers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_model_providers (
    id text NOT NULL,
    org_id text NOT NULL,
    provider text NOT NULL,
    ciphertext bytea NOT NULL,
    nonce bytea NOT NULL,
    key_hint text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT org_model_providers_provider_check CHECK ((provider = ANY (ARRAY['openrouter'::text, 'deepinfra'::text, 'kimi'::text])))
);
--> statement-breakpoint

--
-- Name: org_monthly_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_monthly_usage (
    org_id text NOT NULL,
    month text NOT NULL,
    input_tokens bigint DEFAULT 0 NOT NULL,
    output_tokens bigint DEFAULT 0 NOT NULL,
    cache_read_tokens bigint DEFAULT 0 NOT NULL,
    cost_usd numeric DEFAULT 0 NOT NULL,
    calls bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    studio_builder_runs bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint

--
-- Name: orgs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.orgs (
    id text NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);
--> statement-breakpoint

--
-- Name: recipe_applies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recipe_applies (
    id text NOT NULL,
    org_id text NOT NULL,
    recipe_id text NOT NULL,
    created_by_user_id text,
    guild_id text,
    created_guild boolean DEFAULT false NOT NULL,
    status text NOT NULL,
    recipe_body_version integer NOT NULL,
    preview jsonb DEFAULT '{}'::jsonb NOT NULL,
    plan jsonb DEFAULT '{}'::jsonb NOT NULL,
    checklist jsonb DEFAULT '[]'::jsonb NOT NULL,
    warnings jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT recipe_applies_status_check CHECK ((status = ANY (ARRAY['preview'::text, 'skeleton'::text, 'checklist'::text, 'ready'::text, 'aborted'::text])))
);
--> statement-breakpoint

--
-- Name: recipes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recipes (
    id text NOT NULL,
    org_id text NOT NULL,
    created_by_user_id text,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    visibility text DEFAULT 'private'::text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    body jsonb NOT NULL,
    body_version integer DEFAULT 1 NOT NULL,
    source_kind text NOT NULL,
    source_guild_id text,
    source_builder_session_id text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT recipes_source_kind_check CHECK ((source_kind = ANY (ARRAY['guild'::text, 'builder'::text, 'file'::text]))),
    CONSTRAINT recipes_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'ready'::text]))),
    CONSTRAINT recipes_visibility_check CHECK ((visibility = ANY (ARRAY['private'::text, 'org'::text])))
);
--> statement-breakpoint

--
-- Name: runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.runs (
    id text NOT NULL,
    agent_id text NOT NULL,
    status text NOT NULL,
    config_snapshot jsonb NOT NULL,
    errors jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    archived_at timestamp with time zone,
    system_prompt_hash text,
    task_prompt_hash text,
    kind text DEFAULT 'direct'::text NOT NULL,
    group_chat_through_seq bigint,
    memory_prompt_hash text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    org_id text NOT NULL,
    schedule_id text,
    CONSTRAINT runs_kind_valid CHECK ((kind = ANY (ARRAY['direct'::text, 'group'::text, 'schedule'::text]))),
    CONSTRAINT runs_status_valid CHECK ((status = ANY (ARRAY['active'::text, 'completed'::text])))
);
--> statement-breakpoint

--
-- Name: schedules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schedules (
    id text NOT NULL,
    agent_id text NOT NULL,
    instruction text NOT NULL,
    next_run_at timestamp with time zone NOT NULL,
    last_run_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    cron text,
    paused boolean DEFAULT false NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    wake_window jsonb,
    window_fires integer DEFAULT 0 NOT NULL,
    CONSTRAINT schedules_timing_check CHECK (((cron IS NULL) <> (wake_window IS NULL)))
);
--> statement-breakpoint

--
-- Name: secret_grants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.secret_grants (
    secret_id text NOT NULL,
    guild_id text,
    agent_id text,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT secret_grants_one_target CHECK (((guild_id IS NULL) <> (agent_id IS NULL)))
);
--> statement-breakpoint

--
-- Name: secrets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.secrets (
    id text NOT NULL,
    name text NOT NULL,
    ciphertext bytea NOT NULL,
    nonce bytea NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    rotated_at timestamp with time zone NOT NULL,
    description text NOT NULL,
    org_id text NOT NULL,
    org_wide boolean DEFAULT false NOT NULL,
    created_by_user_id text,
    created_by_agent_id text
);
--> statement-breakpoint

--
-- Name: studio_drafts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.studio_drafts (
    id text NOT NULL,
    session_id text NOT NULL,
    org_id text NOT NULL,
    source_guild_id text,
    resource_kind text NOT NULL,
    target_agent_id text,
    target_snapshot jsonb NOT NULL,
    source_artifact_id text,
    source_display_path text,
    base_version integer NOT NULL,
    base_hash text NOT NULL,
    base_content text NOT NULL,
    proposed_content text NOT NULL,
    rationale text NOT NULL,
    evidence_refs jsonb DEFAULT '[]'::jsonb NOT NULL,
    evidence_warnings jsonb DEFAULT '[]'::jsonb NOT NULL,
    risks jsonb DEFAULT '[]'::jsonb NOT NULL,
    status text NOT NULL,
    draft_number integer NOT NULL,
    supersedes_draft_id text,
    created_generation integer NOT NULL,
    created_message_seq integer NOT NULL,
    created_at timestamp with time zone NOT NULL,
    resolved_at timestamp with time zone,
    published_at timestamp with time zone,
    published_by_user_id text,
    published_resource_version integer,
    CONSTRAINT studio_drafts_resource_kind_check CHECK ((resource_kind = 'agent_task'::text)),
    CONSTRAINT studio_drafts_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'superseded'::text, 'published'::text, 'unchanged'::text, 'discarded'::text, 'conflicted'::text])))
);
--> statement-breakpoint

--
-- Name: studio_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.studio_messages (
    id bigint NOT NULL,
    session_id text NOT NULL,
    seq integer NOT NULL,
    generation integer NOT NULL,
    payload jsonb NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    cost_usd numeric,
    created_at timestamp with time zone NOT NULL
);
--> statement-breakpoint

--
-- Name: studio_messages_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.studio_messages ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.studio_messages_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);
--> statement-breakpoint

--
-- Name: studio_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.studio_sessions (
    id text NOT NULL,
    org_id text NOT NULL,
    created_by_user_id text,
    created_by_name text NOT NULL,
    mode text NOT NULL,
    source_guild_id text,
    source_guild_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    coach_agent_id text,
    coach_snapshot jsonb,
    config_snapshot jsonb NOT NULL,
    selected_target_agent_id text,
    parent_session_id text,
    status text NOT NULL,
    blocked_reason text,
    generation_state text NOT NULL,
    generation_number integer DEFAULT 0 NOT NULL,
    generation_token text,
    generation_started_at timestamp with time zone,
    errors jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    archived_at timestamp with time zone,
    granted_connection_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT studio_sessions_blocked_reason_check CHECK (((blocked_reason IS NULL) OR (blocked_reason = ANY (ARRAY['source_deleted'::text, 'input_token_limit'::text])))),
    CONSTRAINT studio_sessions_generation_state_check CHECK ((generation_state = ANY (ARRAY['idle'::text, 'generating'::text, 'cancelling'::text]))),
    CONSTRAINT studio_sessions_mode_check CHECK ((mode = ANY (ARRAY['optimize'::text, 'create'::text]))),
    CONSTRAINT studio_sessions_status_check CHECK ((status = ANY (ARRAY['active'::text, 'blocked'::text, 'archived'::text])))
);
--> statement-breakpoint

--
-- Name: task_revisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_revisions (
    id text NOT NULL,
    org_id text NOT NULL,
    agent_id text NOT NULL,
    version integer NOT NULL,
    content_text text NOT NULL,
    replaced_at timestamp with time zone NOT NULL,
    replaced_by_type text NOT NULL,
    replaced_by_id text NOT NULL,
    replaced_by_name text NOT NULL,
    created_at timestamp with time zone NOT NULL
);
--> statement-breakpoint

--
-- Name: usage_counters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.usage_counters (
    scope text NOT NULL,
    scope_id text NOT NULL,
    input_tokens bigint DEFAULT 0 NOT NULL,
    output_tokens bigint DEFAULT 0 NOT NULL,
    cache_read_tokens bigint DEFAULT 0 NOT NULL,
    cost_usd numeric DEFAULT 0 NOT NULL,
    calls bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT usage_counters_check CHECK ((((scope = 'global'::text) AND (scope_id = ''::text)) OR ((scope <> 'global'::text) AND (scope_id <> ''::text)))),
    CONSTRAINT usage_counters_scope_check CHECK ((scope = ANY (ARRAY['global'::text, 'org'::text, 'guild'::text, 'agent'::text])))
);
--> statement-breakpoint

--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id text NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    image text,
    email text,
    timezone text,
    color text,
    CONSTRAINT users_color_hex CHECK (((color IS NULL) OR (color ~ '^#[0-9a-f]{6}$'::text)))
);
--> statement-breakpoint

--
-- Name: group_messages id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_messages ALTER COLUMN id SET DEFAULT nextval('public.group_messages_id_seq'::regclass);
--> statement-breakpoint

--
-- Name: messages id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages ALTER COLUMN id SET DEFAULT nextval('public.messages_id_seq'::regclass);
--> statement-breakpoint

--
-- Name: agents agents_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_name_key UNIQUE (name);
--> statement-breakpoint

--
-- Name: agents agents_org_id_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_org_id_id_unique UNIQUE (org_id, id);
--> statement-breakpoint

--
-- Name: agents agents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_pkey PRIMARY KEY (id);
--> statement-breakpoint

--
-- Name: artifact_collections artifact_collections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifact_collections
    ADD CONSTRAINT artifact_collections_pkey PRIMARY KEY (id);
--> statement-breakpoint

--
-- Name: artifacts artifacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifacts
    ADD CONSTRAINT artifacts_pkey PRIMARY KEY (id);
--> statement-breakpoint

--
-- Name: attachments attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_pkey PRIMARY KEY (id);
--> statement-breakpoint

--
-- Name: bindings bindings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bindings
    ADD CONSTRAINT bindings_pkey PRIMARY KEY (id);
--> statement-breakpoint

--
-- Name: builder_messages builder_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.builder_messages
    ADD CONSTRAINT builder_messages_pkey PRIMARY KEY (id);
--> statement-breakpoint

--
-- Name: builder_messages builder_messages_session_id_seq_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.builder_messages
    ADD CONSTRAINT builder_messages_session_id_seq_key UNIQUE (session_id, seq);
--> statement-breakpoint

--
-- Name: builder_sessions builder_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.builder_sessions
    ADD CONSTRAINT builder_sessions_pkey PRIMARY KEY (id);
--> statement-breakpoint

--
-- Name: collection_access collection_access_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collection_access
    ADD CONSTRAINT collection_access_pkey PRIMARY KEY (id);
--> statement-breakpoint

--
-- Name: collection_access collection_access_subject_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collection_access
    ADD CONSTRAINT collection_access_subject_key UNIQUE (collection_id, subject_type, subject_id);
--> statement-breakpoint

--
-- Name: file_changes file_changes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_changes
    ADD CONSTRAINT file_changes_pkey PRIMARY KEY (id);
--> statement-breakpoint

--
-- Name: group_chat_reads group_chat_reads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_chat_reads
    ADD CONSTRAINT group_chat_reads_pkey PRIMARY KEY (guild_id, user_id);
--> statement-breakpoint

--
-- Name: group_messages group_messages_guild_id_seq_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_messages
    ADD CONSTRAINT group_messages_guild_id_seq_key UNIQUE (guild_id, seq);
--> statement-breakpoint

--
-- Name: group_messages group_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_messages
    ADD CONSTRAINT group_messages_pkey PRIMARY KEY (id);
--> statement-breakpoint

--
-- Name: guild_issues guild_issues_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guild_issues
    ADD CONSTRAINT guild_issues_pkey PRIMARY KEY (id);
--> statement-breakpoint

--
-- Name: guild_operators guild_operators_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guild_operators
    ADD CONSTRAINT guild_operators_pkey PRIMARY KEY (guild_id, user_id);
--> statement-breakpoint

--
-- Name: guild_repositories guild_repositories_guild_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guild_repositories
    ADD CONSTRAINT guild_repositories_guild_name_key UNIQUE (guild_id, name);
--> statement-breakpoint

--
-- Name: guild_repositories guild_repositories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guild_repositories
    ADD CONSTRAINT guild_repositories_pkey PRIMARY KEY (id);
--> statement-breakpoint

--
-- Name: guilds guilds_org_id_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guilds
    ADD CONSTRAINT guilds_org_id_id_unique UNIQUE (org_id, id);
--> statement-breakpoint

--
-- Name: guilds guilds_org_name_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guilds
    ADD CONSTRAINT guilds_org_name_unique UNIQUE (org_id, name);
--> statement-breakpoint

--
-- Name: guilds guilds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guilds
    ADD CONSTRAINT guilds_pkey PRIMARY KEY (id);
--> statement-breakpoint

--
-- Name: mcp_catalog_tools mcp_catalog_tools_id_server_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_catalog_tools
    ADD CONSTRAINT mcp_catalog_tools_id_server_key UNIQUE (id, mcp_server_id);
--> statement-breakpoint

--
-- Name: mcp_catalog_tools mcp_catalog_tools_namespaced_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_catalog_tools
    ADD CONSTRAINT mcp_catalog_tools_namespaced_name_key UNIQUE (namespaced_name);
--> statement-breakpoint

--
-- Name: mcp_catalog_tools mcp_catalog_tools_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_catalog_tools
    ADD CONSTRAINT mcp_catalog_tools_pkey PRIMARY KEY (id);
--> statement-breakpoint

--
-- Name: mcp_catalog_tools mcp_catalog_tools_server_remote_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_catalog_tools
    ADD CONSTRAINT mcp_catalog_tools_server_remote_key UNIQUE (mcp_server_id, remote_name);
--> statement-breakpoint

--
-- Name: mcp_connections mcp_connections_id_server_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_connections
    ADD CONSTRAINT mcp_connections_id_server_key UNIQUE (id, mcp_server_id);
--> statement-breakpoint

--
-- Name: mcp_connections mcp_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_connections
    ADD CONSTRAINT mcp_connections_pkey PRIMARY KEY (id);
--> statement-breakpoint

--
-- Name: mcp_servers mcp_servers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_servers
    ADD CONSTRAINT mcp_servers_pkey PRIMARY KEY (id);
--> statement-breakpoint

--
-- Name: mcp_servers mcp_servers_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_servers
    ADD CONSTRAINT mcp_servers_slug_key UNIQUE (slug);
--> statement-breakpoint

--
-- Name: mcp_servers mcp_servers_tool_prefix_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_servers
    ADD CONSTRAINT mcp_servers_tool_prefix_key UNIQUE (tool_prefix);
--> statement-breakpoint

--
-- Name: mcp_tools mcp_tools_connection_id_namespaced_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_tools
    ADD CONSTRAINT mcp_tools_connection_id_namespaced_name_key UNIQUE (connection_id, namespaced_name);
--> statement-breakpoint

--
-- Name: mcp_tools mcp_tools_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_tools
    ADD CONSTRAINT mcp_tools_pkey PRIMARY KEY (id);
--> statement-breakpoint

--
-- Name: memory_revisions memory_revisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_revisions
    ADD CONSTRAINT memory_revisions_pkey PRIMARY KEY (id);
--> statement-breakpoint

--
-- Name: messages messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);
--> statement-breakpoint

--
-- Name: messages messages_run_id_seq_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_run_id_seq_key UNIQUE (run_id, seq);
--> statement-breakpoint

--
-- Name: org_members org_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_members
    ADD CONSTRAINT org_members_pkey PRIMARY KEY (org_id, user_id);
--> statement-breakpoint

--
-- Name: org_model_providers org_model_providers_org_provider_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_model_providers
    ADD CONSTRAINT org_model_providers_org_provider_unique UNIQUE (org_id, provider);
--> statement-breakpoint

--
-- Name: org_model_providers org_model_providers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_model_providers
    ADD CONSTRAINT org_model_providers_pkey PRIMARY KEY (id);
--> statement-breakpoint

--
-- Name: org_monthly_usage org_monthly_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_monthly_usage
    ADD CONSTRAINT org_monthly_usage_pkey PRIMARY KEY (org_id, month);
--> statement-breakpoint

--
-- Name: orgs orgs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orgs
    ADD CONSTRAINT orgs_pkey PRIMARY KEY (id);
--> statement-breakpoint

--
-- Name: orgs orgs_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orgs
    ADD CONSTRAINT orgs_slug_key UNIQUE (slug);
--> statement-breakpoint

--
-- Name: recipe_applies recipe_applies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipe_applies
    ADD CONSTRAINT recipe_applies_pkey PRIMARY KEY (id);
--> statement-breakpoint

--
-- Name: recipes recipes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipes
    ADD CONSTRAINT recipes_pkey PRIMARY KEY (id);
--> statement-breakpoint

--
-- Name: runs runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_pkey PRIMARY KEY (id);
--> statement-breakpoint

--
-- Name: schedules schedules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedules
    ADD CONSTRAINT schedules_pkey PRIMARY KEY (id);
--> statement-breakpoint

--
-- Name: secrets secrets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.secrets
    ADD CONSTRAINT secrets_pkey PRIMARY KEY (id);
--> statement-breakpoint

--
-- Name: studio_drafts studio_drafts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.studio_drafts
    ADD CONSTRAINT studio_drafts_pkey PRIMARY KEY (id);
--> statement-breakpoint

--
-- Name: studio_messages studio_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.studio_messages
    ADD CONSTRAINT studio_messages_pkey PRIMARY KEY (id);
--> statement-breakpoint

--
-- Name: studio_messages studio_messages_session_id_seq_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.studio_messages
    ADD CONSTRAINT studio_messages_session_id_seq_key UNIQUE (session_id, seq);
--> statement-breakpoint

--
-- Name: studio_sessions studio_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.studio_sessions
    ADD CONSTRAINT studio_sessions_pkey PRIMARY KEY (id);
--> statement-breakpoint

--
-- Name: task_revisions task_revisions_agent_version_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_revisions
    ADD CONSTRAINT task_revisions_agent_version_unique UNIQUE (org_id, agent_id, version);
--> statement-breakpoint

--
-- Name: task_revisions task_revisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_revisions
    ADD CONSTRAINT task_revisions_pkey PRIMARY KEY (id);
--> statement-breakpoint

--
-- Name: usage_counters usage_counters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usage_counters
    ADD CONSTRAINT usage_counters_pkey PRIMARY KEY (scope, scope_id);
--> statement-breakpoint

--
-- Name: users users_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_name_key UNIQUE (name);
--> statement-breakpoint

--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);
--> statement-breakpoint

--
-- Name: agents_by_group_delivery; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agents_by_group_delivery ON public.agents USING btree (guild_id, group_chat_delivered_through, created_at);
--> statement-breakpoint

--
-- Name: agents_by_guild; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agents_by_guild ON public.agents USING btree (guild_id, updated_at DESC);
--> statement-breakpoint

--
-- Name: artifact_collections_by_guild; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX artifact_collections_by_guild ON public.artifact_collections USING btree (guild_id);
--> statement-breakpoint

--
-- Name: artifact_collections_org_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX artifact_collections_org_name ON public.artifact_collections USING btree (org_id, name) WHERE (deleted_at IS NULL);
--> statement-breakpoint

--
-- Name: artifacts_by_owner_path; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX artifacts_by_owner_path ON public.artifacts USING btree (org_id, level, owner_id, collection_id, path, key) WHERE (deleted_at IS NULL);
--> statement-breakpoint

--
-- Name: artifacts_natural_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX artifacts_natural_key ON public.artifacts USING btree (org_id, level, owner_id, collection_id, path, key) NULLS NOT DISTINCT WHERE (deleted_at IS NULL);
--> statement-breakpoint

--
-- Name: artifacts_one_memory; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX artifacts_one_memory ON public.artifacts USING btree (agent_id) WHERE ((kind = 'memory'::text) AND (deleted_at IS NULL));
--> statement-breakpoint

--
-- Name: artifacts_record_identity; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX artifacts_record_identity ON public.artifacts USING btree (collection_id, identity) WHERE ((deleted_at IS NULL) AND (identity IS NOT NULL));
--> statement-breakpoint

--
-- Name: artifacts_search_blob_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX artifacts_search_blob_trgm ON public.artifacts USING gin (search_blob public.gin_trgm_ops);
--> statement-breakpoint

--
-- Name: artifacts_search_document; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX artifacts_search_document ON public.artifacts USING gin (search_document);
--> statement-breakpoint

--
-- Name: artifacts_search_text_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX artifacts_search_text_trgm ON public.artifacts USING gin (search_text public.gin_trgm_ops);
--> statement-breakpoint

--
-- Name: attachments_by_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX attachments_by_org ON public.attachments USING btree (org_id, created_at DESC);
--> statement-breakpoint

--
-- Name: bindings_platform_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX bindings_platform_unique ON public.bindings USING btree (catalog_kind, catalog_id) WHERE (scope = 'platform'::text);
--> statement-breakpoint

--
-- Name: bindings_scoped_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX bindings_scoped_unique ON public.bindings USING btree (catalog_kind, catalog_id, scope, scope_id) WHERE (scope_id IS NOT NULL);
--> statement-breakpoint

--
-- Name: builder_messages_by_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX builder_messages_by_session ON public.builder_messages USING btree (session_id, seq);
--> statement-breakpoint

--
-- Name: builder_sessions_by_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX builder_sessions_by_owner ON public.builder_sessions USING btree (org_id, created_by_user_id, updated_at DESC);
--> statement-breakpoint

--
-- Name: builder_sessions_generation_token_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX builder_sessions_generation_token_unique ON public.builder_sessions USING btree (generation_token) WHERE (generation_token IS NOT NULL);
--> statement-breakpoint

--
-- Name: builder_sessions_recipe_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX builder_sessions_recipe_unique ON public.builder_sessions USING btree (recipe_id);
--> statement-breakpoint

--
-- Name: collection_access_by_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX collection_access_by_subject ON public.collection_access USING btree (subject_type, subject_id);
--> statement-breakpoint

--
-- Name: file_changes_by_artifact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX file_changes_by_artifact ON public.file_changes USING btree (artifact_id, created_at);
--> statement-breakpoint

--
-- Name: file_changes_by_path; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX file_changes_by_path ON public.file_changes USING btree (org_id, display_path, created_at);
--> statement-breakpoint

--
-- Name: file_changes_by_tool_call; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX file_changes_by_tool_call ON public.file_changes USING btree (run_id, tool_call_id);
--> statement-breakpoint

--
-- Name: group_chat_reads_by_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX group_chat_reads_by_user ON public.group_chat_reads USING btree (user_id);
--> statement-breakpoint

--
-- Name: guild_issues_by_guild; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX guild_issues_by_guild ON public.guild_issues USING btree (guild_id, status, created_at);
--> statement-breakpoint

--
-- Name: guild_operators_by_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX guild_operators_by_user ON public.guild_operators USING btree (user_id);
--> statement-breakpoint

--
-- Name: guild_repositories_by_connection; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX guild_repositories_by_connection ON public.guild_repositories USING btree (connection_id);
--> statement-breakpoint

--
-- Name: guilds_by_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX guilds_by_org ON public.guilds USING btree (org_id);
--> statement-breakpoint

--
-- Name: mcp_catalog_tools_by_server; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mcp_catalog_tools_by_server ON public.mcp_catalog_tools USING btree (mcp_server_id, publication_state);
--> statement-breakpoint

--
-- Name: mcp_catalog_tools_desc_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mcp_catalog_tools_desc_trgm ON public.mcp_catalog_tools USING gin (description public.gin_trgm_ops);
--> statement-breakpoint

--
-- Name: mcp_catalog_tools_name_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mcp_catalog_tools_name_trgm ON public.mcp_catalog_tools USING gin (namespaced_name public.gin_trgm_ops);
--> statement-breakpoint

--
-- Name: mcp_connections_oauth_state; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX mcp_connections_oauth_state ON public.mcp_connections USING btree (oauth_state) WHERE (oauth_state IS NOT NULL);
--> statement-breakpoint

--
-- Name: mcp_connections_platform_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX mcp_connections_platform_unique ON public.mcp_connections USING btree (mcp_server_id) WHERE (owner_scope = 'platform'::text);
--> statement-breakpoint

--
-- Name: mcp_connections_scoped_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX mcp_connections_scoped_unique ON public.mcp_connections USING btree (mcp_server_id, owner_scope, owner_id) WHERE (owner_id IS NOT NULL);
--> statement-breakpoint

--
-- Name: mcp_servers_desc_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mcp_servers_desc_trgm ON public.mcp_servers USING gin (description public.gin_trgm_ops);
--> statement-breakpoint

--
-- Name: mcp_servers_display_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mcp_servers_display_trgm ON public.mcp_servers USING gin (display_name public.gin_trgm_ops);
--> statement-breakpoint

--
-- Name: mcp_tools_by_connection; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mcp_tools_by_connection ON public.mcp_tools USING btree (connection_id);
--> statement-breakpoint

--
-- Name: memory_revisions_by_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX memory_revisions_by_agent ON public.memory_revisions USING btree (org_id, agent_id, replaced_at DESC);
--> statement-breakpoint

--
-- Name: org_members_by_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX org_members_by_user ON public.org_members USING btree (user_id);
--> statement-breakpoint

--
-- Name: recipe_applies_by_guild; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recipe_applies_by_guild ON public.recipe_applies USING btree (guild_id, updated_at DESC) WHERE (guild_id IS NOT NULL);
--> statement-breakpoint

--
-- Name: recipe_applies_by_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recipe_applies_by_org ON public.recipe_applies USING btree (org_id, updated_at DESC);
--> statement-breakpoint

--
-- Name: recipe_applies_open_guild; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX recipe_applies_open_guild ON public.recipe_applies USING btree (guild_id) WHERE ((guild_id IS NOT NULL) AND (status = ANY (ARRAY['skeleton'::text, 'checklist'::text])));
--> statement-breakpoint

--
-- Name: recipes_by_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recipes_by_org ON public.recipes USING btree (org_id, updated_at DESC);
--> statement-breakpoint

--
-- Name: runs_by_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX runs_by_agent ON public.runs USING btree (agent_id, updated_at DESC);
--> statement-breakpoint

--
-- Name: runs_by_agent_task_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX runs_by_agent_task_hash ON public.runs USING btree (agent_id, task_prompt_hash);
--> statement-breakpoint

--
-- Name: runs_by_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX runs_by_org ON public.runs USING btree (org_id);
--> statement-breakpoint

--
-- Name: runs_by_schedule; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX runs_by_schedule ON public.runs USING btree (schedule_id, created_at);
--> statement-breakpoint

--
-- Name: schedules_by_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX schedules_by_agent ON public.schedules USING btree (agent_id, created_at);
--> statement-breakpoint

--
-- Name: schedules_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX schedules_due ON public.schedules USING btree (next_run_at);
--> statement-breakpoint

--
-- Name: secret_grants_agent_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX secret_grants_agent_unique ON public.secret_grants USING btree (secret_id, agent_id) WHERE (agent_id IS NOT NULL);
--> statement-breakpoint

--
-- Name: secret_grants_by_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX secret_grants_by_agent ON public.secret_grants USING btree (agent_id);
--> statement-breakpoint

--
-- Name: secret_grants_by_guild; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX secret_grants_by_guild ON public.secret_grants USING btree (guild_id);
--> statement-breakpoint

--
-- Name: secret_grants_guild_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX secret_grants_guild_unique ON public.secret_grants USING btree (secret_id, guild_id) WHERE (guild_id IS NOT NULL);
--> statement-breakpoint

--
-- Name: secrets_org_name_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX secrets_org_name_unique ON public.secrets USING btree (org_id, name);
--> statement-breakpoint

--
-- Name: studio_drafts_by_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX studio_drafts_by_session ON public.studio_drafts USING btree (session_id, created_at DESC);
--> statement-breakpoint

--
-- Name: studio_drafts_head_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX studio_drafts_head_unique ON public.studio_drafts USING btree (session_id, target_agent_id, resource_kind) WHERE (status = 'draft'::text);
--> statement-breakpoint

--
-- Name: studio_messages_by_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX studio_messages_by_session ON public.studio_messages USING btree (session_id, seq);
--> statement-breakpoint

--
-- Name: studio_sessions_by_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX studio_sessions_by_owner ON public.studio_sessions USING btree (org_id, created_by_user_id, updated_at DESC);
--> statement-breakpoint

--
-- Name: studio_sessions_by_source_guild; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX studio_sessions_by_source_guild ON public.studio_sessions USING btree (source_guild_id, updated_at DESC) WHERE (source_guild_id IS NOT NULL);
--> statement-breakpoint

--
-- Name: studio_sessions_generation_token_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX studio_sessions_generation_token_unique ON public.studio_sessions USING btree (generation_token) WHERE (generation_token IS NOT NULL);
--> statement-breakpoint

--
-- Name: task_revisions_by_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX task_revisions_by_agent ON public.task_revisions USING btree (org_id, agent_id, version DESC);
--> statement-breakpoint

--
-- Name: users_email_lower_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX users_email_lower_unique ON public.users USING btree (lower(email)) WHERE (email IS NOT NULL);
--> statement-breakpoint

--
-- Name: agents agents_guild_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_guild_id_fkey FOREIGN KEY (guild_id) REFERENCES public.guilds(id) ON DELETE CASCADE;
--> statement-breakpoint

--
-- Name: agents agents_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agents
    ADD CONSTRAINT agents_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id);
--> statement-breakpoint

--
-- Name: artifact_collections artifact_collections_guild_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifact_collections
    ADD CONSTRAINT artifact_collections_guild_id_fkey FOREIGN KEY (guild_id) REFERENCES public.guilds(id) ON DELETE SET NULL;
--> statement-breakpoint

--
-- Name: artifact_collections artifact_collections_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifact_collections
    ADD CONSTRAINT artifact_collections_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id);
--> statement-breakpoint

--
-- Name: artifacts artifacts_agent_org_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifacts
    ADD CONSTRAINT artifacts_agent_org_fkey FOREIGN KEY (org_id, agent_id) REFERENCES public.agents(org_id, id) ON DELETE CASCADE;
--> statement-breakpoint

--
-- Name: artifacts artifacts_collection_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifacts
    ADD CONSTRAINT artifacts_collection_fkey FOREIGN KEY (collection_id) REFERENCES public.artifact_collections(id);
--> statement-breakpoint

--
-- Name: artifacts artifacts_guild_org_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifacts
    ADD CONSTRAINT artifacts_guild_org_fkey FOREIGN KEY (org_id, guild_id) REFERENCES public.guilds(org_id, id) ON DELETE CASCADE;
--> statement-breakpoint

--
-- Name: artifacts artifacts_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.artifacts
    ADD CONSTRAINT artifacts_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id);
--> statement-breakpoint

--
-- Name: attachments attachments_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint

--
-- Name: attachments attachments_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.users(id) ON DELETE RESTRICT;
--> statement-breakpoint

--
-- Name: bindings bindings_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bindings
    ADD CONSTRAINT bindings_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
--> statement-breakpoint

--
-- Name: bindings bindings_connection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bindings
    ADD CONSTRAINT bindings_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES public.mcp_connections(id) ON DELETE CASCADE;
--> statement-breakpoint

--
-- Name: bindings bindings_guild_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bindings
    ADD CONSTRAINT bindings_guild_id_fkey FOREIGN KEY (guild_id) REFERENCES public.guilds(id) ON DELETE CASCADE;
--> statement-breakpoint

--
-- Name: bindings bindings_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bindings
    ADD CONSTRAINT bindings_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint

--
-- Name: builder_messages builder_messages_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.builder_messages
    ADD CONSTRAINT builder_messages_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.builder_sessions(id) ON DELETE CASCADE;
--> statement-breakpoint

--
-- Name: builder_sessions builder_sessions_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.builder_sessions
    ADD CONSTRAINT builder_sessions_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;
--> statement-breakpoint

--
-- Name: builder_sessions builder_sessions_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.builder_sessions
    ADD CONSTRAINT builder_sessions_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint

--
-- Name: builder_sessions builder_sessions_recipe_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.builder_sessions
    ADD CONSTRAINT builder_sessions_recipe_id_fkey FOREIGN KEY (recipe_id) REFERENCES public.recipes(id) ON DELETE RESTRICT;
--> statement-breakpoint

--
-- Name: collection_access collection_access_collection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collection_access
    ADD CONSTRAINT collection_access_collection_id_fkey FOREIGN KEY (collection_id) REFERENCES public.artifact_collections(id) ON DELETE CASCADE;
--> statement-breakpoint

--
-- Name: collection_access collection_access_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.collection_access
    ADD CONSTRAINT collection_access_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint

--
-- Name: file_changes file_changes_artifact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_changes
    ADD CONSTRAINT file_changes_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES public.artifacts(id) ON DELETE CASCADE;
--> statement-breakpoint

--
-- Name: file_changes file_changes_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_changes
    ADD CONSTRAINT file_changes_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint

--
-- Name: file_changes file_changes_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_changes
    ADD CONSTRAINT file_changes_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE SET NULL;
--> statement-breakpoint

--
-- Name: file_changes file_changes_task_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file_changes
    ADD CONSTRAINT file_changes_task_agent_id_fkey FOREIGN KEY (task_agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
--> statement-breakpoint

--
-- Name: group_chat_reads group_chat_reads_guild_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_chat_reads
    ADD CONSTRAINT group_chat_reads_guild_id_fkey FOREIGN KEY (guild_id) REFERENCES public.guilds(id) ON DELETE CASCADE;
--> statement-breakpoint

--
-- Name: group_chat_reads group_chat_reads_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_chat_reads
    ADD CONSTRAINT group_chat_reads_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint

--
-- Name: group_messages group_messages_author_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_messages
    ADD CONSTRAINT group_messages_author_agent_id_fkey FOREIGN KEY (author_agent_id) REFERENCES public.agents(id) ON DELETE SET NULL;
--> statement-breakpoint

--
-- Name: group_messages group_messages_guild_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_messages
    ADD CONSTRAINT group_messages_guild_id_fkey FOREIGN KEY (guild_id) REFERENCES public.guilds(id) ON DELETE CASCADE;
--> statement-breakpoint

--
-- Name: group_messages group_messages_source_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_messages
    ADD CONSTRAINT group_messages_source_run_id_fkey FOREIGN KEY (source_run_id) REFERENCES public.runs(id) ON DELETE SET NULL;
--> statement-breakpoint

--
-- Name: guild_issues guild_issues_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guild_issues
    ADD CONSTRAINT guild_issues_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE SET NULL;
--> statement-breakpoint

--
-- Name: guild_issues guild_issues_guild_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guild_issues
    ADD CONSTRAINT guild_issues_guild_id_fkey FOREIGN KEY (guild_id) REFERENCES public.guilds(id) ON DELETE CASCADE;
--> statement-breakpoint

--
-- Name: guild_issues guild_issues_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guild_issues
    ADD CONSTRAINT guild_issues_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint

--
-- Name: guild_issues guild_issues_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guild_issues
    ADD CONSTRAINT guild_issues_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE SET NULL;
--> statement-breakpoint

--
-- Name: guild_operators guild_operators_guild_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guild_operators
    ADD CONSTRAINT guild_operators_guild_fkey FOREIGN KEY (org_id, guild_id) REFERENCES public.guilds(org_id, id) ON DELETE CASCADE;
--> statement-breakpoint

--
-- Name: guild_operators guild_operators_member_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guild_operators
    ADD CONSTRAINT guild_operators_member_fkey FOREIGN KEY (org_id, user_id) REFERENCES public.org_members(org_id, user_id) ON DELETE CASCADE;
--> statement-breakpoint

--
-- Name: guild_repositories guild_repositories_connection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guild_repositories
    ADD CONSTRAINT guild_repositories_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES public.mcp_connections(id) ON DELETE SET NULL;
--> statement-breakpoint

--
-- Name: guild_repositories guild_repositories_guild_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guild_repositories
    ADD CONSTRAINT guild_repositories_guild_id_fkey FOREIGN KEY (guild_id) REFERENCES public.guilds(id) ON DELETE CASCADE;
--> statement-breakpoint

--
-- Name: guilds guilds_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.guilds
    ADD CONSTRAINT guilds_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id);
--> statement-breakpoint

--
-- Name: mcp_catalog_tools mcp_catalog_tools_mcp_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_catalog_tools
    ADD CONSTRAINT mcp_catalog_tools_mcp_server_id_fkey FOREIGN KEY (mcp_server_id) REFERENCES public.mcp_servers(id) ON DELETE CASCADE;
--> statement-breakpoint

--
-- Name: mcp_connections mcp_connections_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_connections
    ADD CONSTRAINT mcp_connections_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
--> statement-breakpoint

--
-- Name: mcp_connections mcp_connections_guild_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_connections
    ADD CONSTRAINT mcp_connections_guild_id_fkey FOREIGN KEY (guild_id) REFERENCES public.guilds(id) ON DELETE CASCADE;
--> statement-breakpoint

--
-- Name: mcp_connections mcp_connections_mcp_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_connections
    ADD CONSTRAINT mcp_connections_mcp_server_id_fkey FOREIGN KEY (mcp_server_id) REFERENCES public.mcp_servers(id) ON DELETE CASCADE;
--> statement-breakpoint

--
-- Name: mcp_connections mcp_connections_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_connections
    ADD CONSTRAINT mcp_connections_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint

--
-- Name: mcp_tools mcp_tools_catalog_server_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_tools
    ADD CONSTRAINT mcp_tools_catalog_server_fkey FOREIGN KEY (catalog_tool_id, mcp_server_id) REFERENCES public.mcp_catalog_tools(id, mcp_server_id);
--> statement-breakpoint

--
-- Name: mcp_tools mcp_tools_connection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_tools
    ADD CONSTRAINT mcp_tools_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES public.mcp_connections(id) ON DELETE CASCADE;
--> statement-breakpoint

--
-- Name: mcp_tools mcp_tools_connection_server_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_tools
    ADD CONSTRAINT mcp_tools_connection_server_fkey FOREIGN KEY (connection_id, mcp_server_id) REFERENCES public.mcp_connections(id, mcp_server_id) ON DELETE CASCADE;
--> statement-breakpoint

--
-- Name: memory_revisions memory_revisions_agent_org_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_revisions
    ADD CONSTRAINT memory_revisions_agent_org_fkey FOREIGN KEY (org_id, agent_id) REFERENCES public.agents(org_id, id) ON DELETE CASCADE;
--> statement-breakpoint

--
-- Name: memory_revisions memory_revisions_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_revisions
    ADD CONSTRAINT memory_revisions_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id);
--> statement-breakpoint

--
-- Name: messages messages_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE CASCADE;
--> statement-breakpoint

--
-- Name: org_members org_members_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_members
    ADD CONSTRAINT org_members_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint

--
-- Name: org_members org_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_members
    ADD CONSTRAINT org_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
--> statement-breakpoint

--
-- Name: org_model_providers org_model_providers_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_model_providers
    ADD CONSTRAINT org_model_providers_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint

--
-- Name: org_monthly_usage org_monthly_usage_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_monthly_usage
    ADD CONSTRAINT org_monthly_usage_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint

--
-- Name: recipe_applies recipe_applies_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipe_applies
    ADD CONSTRAINT recipe_applies_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;
--> statement-breakpoint

--
-- Name: recipe_applies recipe_applies_guild_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipe_applies
    ADD CONSTRAINT recipe_applies_guild_id_fkey FOREIGN KEY (guild_id) REFERENCES public.guilds(id) ON DELETE SET NULL;
--> statement-breakpoint

--
-- Name: recipe_applies recipe_applies_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipe_applies
    ADD CONSTRAINT recipe_applies_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint

--
-- Name: recipe_applies recipe_applies_recipe_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipe_applies
    ADD CONSTRAINT recipe_applies_recipe_id_fkey FOREIGN KEY (recipe_id) REFERENCES public.recipes(id) ON DELETE CASCADE;
--> statement-breakpoint

--
-- Name: recipes recipes_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipes
    ADD CONSTRAINT recipes_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;
--> statement-breakpoint

--
-- Name: recipes recipes_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipes
    ADD CONSTRAINT recipes_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint

--
-- Name: recipes recipes_source_builder_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipes
    ADD CONSTRAINT recipes_source_builder_session_id_fkey FOREIGN KEY (source_builder_session_id) REFERENCES public.builder_sessions(id) ON DELETE SET NULL;
--> statement-breakpoint

--
-- Name: recipes recipes_source_guild_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recipes
    ADD CONSTRAINT recipes_source_guild_id_fkey FOREIGN KEY (source_guild_id) REFERENCES public.guilds(id) ON DELETE SET NULL;
--> statement-breakpoint

--
-- Name: runs runs_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
--> statement-breakpoint

--
-- Name: runs runs_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id);
--> statement-breakpoint

--
-- Name: schedules schedules_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedules
    ADD CONSTRAINT schedules_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
--> statement-breakpoint

--
-- Name: secret_grants secret_grants_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.secret_grants
    ADD CONSTRAINT secret_grants_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
--> statement-breakpoint

--
-- Name: secret_grants secret_grants_guild_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.secret_grants
    ADD CONSTRAINT secret_grants_guild_id_fkey FOREIGN KEY (guild_id) REFERENCES public.guilds(id) ON DELETE CASCADE;
--> statement-breakpoint

--
-- Name: secret_grants secret_grants_secret_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.secret_grants
    ADD CONSTRAINT secret_grants_secret_id_fkey FOREIGN KEY (secret_id) REFERENCES public.secrets(id) ON DELETE CASCADE;
--> statement-breakpoint

--
-- Name: secrets secrets_created_by_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.secrets
    ADD CONSTRAINT secrets_created_by_agent_id_fkey FOREIGN KEY (created_by_agent_id) REFERENCES public.agents(id) ON DELETE SET NULL;
--> statement-breakpoint

--
-- Name: secrets secrets_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.secrets
    ADD CONSTRAINT secrets_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;
--> statement-breakpoint

--
-- Name: secrets secrets_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.secrets
    ADD CONSTRAINT secrets_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint

--
-- Name: studio_drafts studio_drafts_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.studio_drafts
    ADD CONSTRAINT studio_drafts_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint

--
-- Name: studio_drafts studio_drafts_published_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.studio_drafts
    ADD CONSTRAINT studio_drafts_published_by_user_id_fkey FOREIGN KEY (published_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;
--> statement-breakpoint

--
-- Name: studio_drafts studio_drafts_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.studio_drafts
    ADD CONSTRAINT studio_drafts_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.studio_sessions(id) ON DELETE CASCADE;
--> statement-breakpoint

--
-- Name: studio_drafts studio_drafts_source_artifact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.studio_drafts
    ADD CONSTRAINT studio_drafts_source_artifact_id_fkey FOREIGN KEY (source_artifact_id) REFERENCES public.artifacts(id) ON DELETE SET NULL;
--> statement-breakpoint

--
-- Name: studio_drafts studio_drafts_source_guild_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.studio_drafts
    ADD CONSTRAINT studio_drafts_source_guild_id_fkey FOREIGN KEY (source_guild_id) REFERENCES public.guilds(id) ON DELETE SET NULL;
--> statement-breakpoint

--
-- Name: studio_drafts studio_drafts_supersedes_draft_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.studio_drafts
    ADD CONSTRAINT studio_drafts_supersedes_draft_id_fkey FOREIGN KEY (supersedes_draft_id) REFERENCES public.studio_drafts(id) ON DELETE SET NULL;
--> statement-breakpoint

--
-- Name: studio_drafts studio_drafts_target_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.studio_drafts
    ADD CONSTRAINT studio_drafts_target_agent_id_fkey FOREIGN KEY (target_agent_id) REFERENCES public.agents(id) ON DELETE SET NULL;
--> statement-breakpoint

--
-- Name: studio_messages studio_messages_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.studio_messages
    ADD CONSTRAINT studio_messages_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.studio_sessions(id) ON DELETE CASCADE;
--> statement-breakpoint

--
-- Name: studio_sessions studio_sessions_coach_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.studio_sessions
    ADD CONSTRAINT studio_sessions_coach_agent_id_fkey FOREIGN KEY (coach_agent_id) REFERENCES public.agents(id) ON DELETE SET NULL;
--> statement-breakpoint

--
-- Name: studio_sessions studio_sessions_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.studio_sessions
    ADD CONSTRAINT studio_sessions_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;
--> statement-breakpoint

--
-- Name: studio_sessions studio_sessions_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.studio_sessions
    ADD CONSTRAINT studio_sessions_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint

--
-- Name: studio_sessions studio_sessions_parent_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.studio_sessions
    ADD CONSTRAINT studio_sessions_parent_session_id_fkey FOREIGN KEY (parent_session_id) REFERENCES public.studio_sessions(id) ON DELETE SET NULL;
--> statement-breakpoint

--
-- Name: studio_sessions studio_sessions_selected_target_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.studio_sessions
    ADD CONSTRAINT studio_sessions_selected_target_agent_id_fkey FOREIGN KEY (selected_target_agent_id) REFERENCES public.agents(id) ON DELETE SET NULL;
--> statement-breakpoint

--
-- Name: studio_sessions studio_sessions_source_guild_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.studio_sessions
    ADD CONSTRAINT studio_sessions_source_guild_id_fkey FOREIGN KEY (source_guild_id) REFERENCES public.guilds(id) ON DELETE SET NULL;
--> statement-breakpoint

--
-- Name: task_revisions task_revisions_agent_org_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_revisions
    ADD CONSTRAINT task_revisions_agent_org_fkey FOREIGN KEY (org_id, agent_id) REFERENCES public.agents(org_id, id) ON DELETE CASCADE;
--> statement-breakpoint

--
-- Name: task_revisions task_revisions_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_revisions
    ADD CONSTRAINT task_revisions_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id);
--> statement-breakpoint
