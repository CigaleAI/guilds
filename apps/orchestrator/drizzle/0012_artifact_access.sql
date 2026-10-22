-- One access list per note and per table: each row gives the organisation, a guild, or an agent a mode on one item.
CREATE TABLE public.artifact_access (
	id text PRIMARY KEY,
	org_id text NOT NULL,
	target_kind text NOT NULL,
	target_id text NOT NULL,
	subject_type text NOT NULL,
	subject_id text NOT NULL,
	mode text NOT NULL,
	created_by_type text NOT NULL,
	created_by_id text NOT NULL,
	created_by_name text NOT NULL,
	created_at timestamp with time zone NOT NULL,
	updated_by_type text NOT NULL,
	updated_by_id text NOT NULL,
	updated_by_name text NOT NULL,
	updated_at timestamp with time zone NOT NULL,
	CONSTRAINT artifact_access_target_check CHECK (target_kind IN ('note', 'collection')),
	CONSTRAINT artifact_access_subject_check CHECK (subject_type IN ('org', 'guild', 'agent')),
	CONSTRAINT artifact_access_mode_check CHECK (mode IN ('read', 'write', 'none')),
	CONSTRAINT artifact_access_none_is_agent CHECK (mode <> 'none' OR subject_type = 'agent')
);
--> statement-breakpoint
ALTER TABLE public.artifact_access ADD CONSTRAINT artifact_access_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE public.artifact_access ADD CONSTRAINT artifact_access_subject_key UNIQUE (target_kind, target_id, subject_type, subject_id);
--> statement-breakpoint
CREATE INDEX artifact_access_by_subject ON public.artifact_access USING btree (subject_type, subject_id);
--> statement-breakpoint
-- Every row a live table had.
INSERT INTO public.artifact_access (
	id, org_id, target_kind, target_id, subject_type, subject_id, mode,
	created_by_type, created_by_id, created_by_name, created_at,
	updated_by_type, updated_by_id, updated_by_name, updated_at
)
SELECT x.id, x.org_id, 'collection', x.collection_id, x.subject_type, x.subject_id, x.mode,
       x.created_by_type, x.created_by_id, x.created_by_name, x.created_at,
       x.created_by_type, x.created_by_id, x.created_by_name, x.created_at
  FROM public.collection_access x
  JOIN public.artifact_collections c ON c.id = x.collection_id AND c.deleted_at IS NULL;
--> statement-breakpoint
-- A guild's own table: its guild writes it.
INSERT INTO public.artifact_access (
	id, org_id, target_kind, target_id, subject_type, subject_id, mode,
	created_by_type, created_by_id, created_by_name, created_at,
	updated_by_type, updated_by_id, updated_by_name, updated_at
)
SELECT 'aacc_' || upper(substr(md5(random()::text || clock_timestamp()::text || c.id), 1, 26)),
       c.org_id, 'collection', c.id, 'guild', c.guild_id, 'write',
       c.created_by_type, c.created_by_id, c.created_by_name, c.created_at,
       c.created_by_type, c.created_by_id, c.created_by_name, c.created_at
  FROM public.artifact_collections c
 WHERE c.guild_id IS NOT NULL AND c.deleted_at IS NULL
ON CONFLICT (target_kind, target_id, subject_type, subject_id) DO NOTHING;
--> statement-breakpoint
-- An organisation table: the organisation reads it, unless it already has a row.
INSERT INTO public.artifact_access (
	id, org_id, target_kind, target_id, subject_type, subject_id, mode,
	created_by_type, created_by_id, created_by_name, created_at,
	updated_by_type, updated_by_id, updated_by_name, updated_at
)
SELECT 'aacc_' || upper(substr(md5(random()::text || clock_timestamp()::text || c.id), 1, 26)),
       c.org_id, 'collection', c.id, 'org', c.org_id, 'read',
       c.created_by_type, c.created_by_id, c.created_by_name, c.created_at,
       c.created_by_type, c.created_by_id, c.created_by_name, c.created_at
  FROM public.artifact_collections c
 WHERE c.guild_id IS NULL AND c.deleted_at IS NULL
ON CONFLICT (target_kind, target_id, subject_type, subject_id) DO NOTHING;
--> statement-breakpoint
-- A guild note: its guild writes it. An organisation note: the organisation reads it.
INSERT INTO public.artifact_access (
	id, org_id, target_kind, target_id, subject_type, subject_id, mode,
	created_by_type, created_by_id, created_by_name, created_at,
	updated_by_type, updated_by_id, updated_by_name, updated_at
)
SELECT 'aacc_' || upper(substr(md5(random()::text || clock_timestamp()::text || a.id), 1, 26)),
       a.org_id, 'note', a.id, a.level, a.owner_id, CASE a.level WHEN 'guild' THEN 'write' ELSE 'read' END,
       a.created_by_type, a.created_by_id, a.created_by_name, a.created_at,
       a.created_by_type, a.created_by_id, a.created_by_name, a.created_at
  FROM public.artifacts a
 WHERE a.kind = 'note' AND a.level IN ('guild', 'org') AND a.deleted_at IS NULL;
--> statement-breakpoint
DROP TABLE public.collection_access;
--> statement-breakpoint
DELETE FROM public.bindings WHERE catalog_kind = 'artifact_grant';
--> statement-breakpoint
ALTER TABLE public.bindings DROP CONSTRAINT bindings_catalog_kind_check;
--> statement-breakpoint
ALTER TABLE public.bindings ADD CONSTRAINT bindings_catalog_kind_check CHECK (catalog_kind IN ('native_tool', 'mcp', 'mcp_tool'));
--> statement-breakpoint
-- A change to a note's access list is logged against the note.
ALTER TABLE public.config_changes DROP CONSTRAINT config_changes_target_kind_check;
--> statement-breakpoint
ALTER TABLE public.config_changes ADD CONSTRAINT config_changes_target_kind_check CHECK (target_kind IN ('routine', 'access', 'guild_text', 'collection', 'note'));
