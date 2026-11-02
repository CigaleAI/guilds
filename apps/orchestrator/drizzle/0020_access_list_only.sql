-- A note or a file has an access list and nothing else: no level, no owner, no guild. Its name is
-- unique in its organisation; Memory and scripts stay unique per agent.
CREATE TABLE public.artifact_renames (
	org_id text NOT NULL,
	artifact_id text NOT NULL,
	old_display_path text NOT NULL,
	new_display_path text NOT NULL,
	renamed_at timestamp with time zone NOT NULL,
	CONSTRAINT artifact_renames_pkey PRIMARY KEY (artifact_id, renamed_at)
);
--> statement-breakpoint
ALTER TABLE public.artifact_renames ADD CONSTRAINT artifact_renames_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE public.artifact_renames ADD CONSTRAINT artifact_renames_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES public.artifacts(id) ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX artifact_renames_by_org ON public.artifact_renames USING btree (org_id, renamed_at);
--> statement-breakpoint
-- An agent's own note or file: the agent writes it, now through a row of its list.
INSERT INTO public.artifact_access (
	id, org_id, target_kind, target_id, subject_type, subject_id, mode,
	created_by_type, created_by_id, created_by_name, created_at,
	updated_by_type, updated_by_id, updated_by_name, updated_at
)
SELECT 'aacc_' || upper(substr(md5(random()::text || clock_timestamp()::text || a.id), 1, 26)),
       a.org_id, a.kind, a.id, 'agent', a.owner_id, 'write',
       a.created_by_type, a.created_by_id, a.created_by_name, a.created_at,
       a.created_by_type, a.created_by_id, a.created_by_name, a.created_at
  FROM public.artifacts a
 WHERE a.kind IN ('note', 'file') AND a.level = 'agent' AND a.deleted_at IS NULL
ON CONFLICT (target_kind, target_id, subject_type, subject_id) DO UPDATE SET mode = 'write';
--> statement-breakpoint
-- Every live note and file, with the display path it had and the name of the organisation, guild,
-- or agent that held it.
CREATE TEMPORARY TABLE artifact_moves AS
SELECT a.id, a.org_id, a.kind, a.path, a.key AS old_key, a.key AS new_key, a.created_at, a.owner_id,
       CASE a.level
         WHEN 'agent' THEN 'org/' || a.org_id || '/agents/' || a.owner_id || '/'
         WHEN 'guild' THEN 'org/' || a.org_id || '/guilds/' || a.owner_id || '/'
         ELSE 'org/' || a.org_id || '/'
       END || CASE WHEN a.path = '' THEN '' ELSE a.path || '/' END || a.key AS old_display_path,
       COALESCE(CASE a.level
         WHEN 'agent' THEN (SELECT ag.name FROM public.agents ag WHERE ag.id = a.owner_id)
         WHEN 'guild' THEN (SELECT g.name FROM public.guilds g WHERE g.id = a.owner_id)
         ELSE (SELECT o.name FROM public.orgs o WHERE o.id = a.owner_id)
       END, a.owner_id) AS owner_name
  FROM public.artifacts a
 WHERE a.kind IN ('note', 'file') AND a.deleted_at IS NULL;
--> statement-breakpoint
-- Names that several owners held: the oldest keeps its name, each later one takes its owner's
-- name as a prefix (the owner's id when the name leaves nothing), numbered when that is taken too.
DO $$
DECLARE
  moved record;
  slug text;
  candidate text;
  n integer;
BEGIN
  FOR moved IN
    SELECT m.* FROM artifact_moves m
     WHERE EXISTS (
       SELECT 1 FROM artifact_moves o
        WHERE o.org_id = m.org_id AND o.kind = m.kind AND o.path = m.path AND o.old_key = m.old_key
          AND (o.created_at, o.id) < (m.created_at, m.id))
     ORDER BY m.created_at, m.id
  LOOP
    slug := btrim(regexp_replace(lower(moved.owner_name), '[^a-z0-9]+', '-', 'g'), '-');
    IF slug = '' THEN
      slug := moved.owner_id;
    END IF;
    candidate := slug || '-' || moved.old_key;
    n := 1;
    WHILE EXISTS (
      SELECT 1 FROM artifact_moves t
       WHERE t.org_id = moved.org_id AND t.kind = moved.kind AND t.path = moved.path
         AND t.new_key = candidate AND t.id <> moved.id)
    LOOP
      n := n + 1;
      candidate := slug || '-' || n || '-' || moved.old_key;
    END LOOP;
    UPDATE artifact_moves SET new_key = candidate WHERE id = moved.id;
  END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE artifact_moves ADD COLUMN new_display_path text;
--> statement-breakpoint
UPDATE artifact_moves
   SET new_display_path = 'org/' || org_id || '/' || CASE WHEN path = '' THEN '' ELSE path || '/' END || new_key;
--> statement-breakpoint
DROP INDEX public.artifacts_natural_key;
--> statement-breakpoint
DROP INDEX public.artifacts_by_owner_path;
--> statement-breakpoint
ALTER TABLE public.artifacts DROP CONSTRAINT artifacts_level_agent;
--> statement-breakpoint
ALTER TABLE public.artifacts DROP CONSTRAINT artifacts_level_guild;
--> statement-breakpoint
ALTER TABLE public.artifacts DROP CONSTRAINT artifacts_level_org;
--> statement-breakpoint
ALTER TABLE public.artifacts DROP CONSTRAINT artifacts_level_check;
--> statement-breakpoint
ALTER TABLE public.artifacts DROP CONSTRAINT artifacts_task_memory;
--> statement-breakpoint
ALTER TABLE public.artifacts DROP CONSTRAINT artifacts_kind_text;
--> statement-breakpoint
ALTER TABLE public.artifacts DROP CONSTRAINT artifacts_guild_org_fkey;
--> statement-breakpoint
UPDATE public.artifacts SET agent_id = NULL WHERE kind IN ('note', 'file');
--> statement-breakpoint
UPDATE public.artifacts a
   SET key = m.new_key,
       search_text = CASE a.kind
         WHEN 'note' THEN left(concat_ws(' ', NULLIF(a.title, ''), m.new_key), 400)
         ELSE left(m.new_key || ' ' || a.title, 400)
       END
  FROM artifact_moves m
 WHERE m.id = a.id AND m.new_key <> m.old_key;
--> statement-breakpoint
INSERT INTO public.artifact_renames (org_id, artifact_id, old_display_path, new_display_path, renamed_at)
SELECT m.org_id, m.id, m.old_display_path, m.new_display_path, now()
  FROM artifact_moves m
 WHERE m.new_key <> m.old_key;
--> statement-breakpoint
-- Every embed and every mention of a moved item's display path now names where it is, longest
-- path first so that no path is rewritten inside a longer one.
DO $$
DECLARE
  moved record;
BEGIN
  FOR moved IN
    SELECT org_id, old_display_path AS old_path, new_display_path AS new_path
      FROM artifact_moves
     WHERE old_display_path <> new_display_path
     ORDER BY length(old_display_path) DESC, old_display_path
  LOOP
    UPDATE public.agents
       SET task = replace(task, moved.old_path, moved.new_path),
           task_hash = encode(sha256(convert_to(replace(task, moved.old_path, moved.new_path), 'UTF8')), 'hex')
     WHERE org_id = moved.org_id AND strpos(task, moved.old_path) > 0;
    UPDATE public.task_revisions
       SET content_text = replace(content_text, moved.old_path, moved.new_path)
     WHERE org_id = moved.org_id AND strpos(content_text, moved.old_path) > 0;
    UPDATE public.artifacts
       SET content_text = replace(content_text, moved.old_path, moved.new_path),
           content_hash = encode(sha256(convert_to(replace(content_text, moved.old_path, moved.new_path), 'UTF8')), 'hex')
     WHERE org_id = moved.org_id AND kind IN ('note', 'memory') AND content_text IS NOT NULL
       AND strpos(content_text, moved.old_path) > 0;
    UPDATE public.recipes
       SET body = replace(body::text, moved.old_path, moved.new_path)::jsonb
     WHERE org_id = moved.org_id AND strpos(body::text, moved.old_path) > 0;
    UPDATE public.studio_drafts
       SET source_display_path = moved.new_path
     WHERE org_id = moved.org_id AND source_display_path = moved.old_path;
  END LOOP;
END $$;
--> statement-breakpoint
-- A moved item's change history follows it to its new display path.
UPDATE public.file_changes f
   SET display_path = m.new_display_path
  FROM artifact_moves m
 WHERE f.artifact_id = m.id AND f.display_path <> m.new_display_path;
--> statement-breakpoint
DROP TABLE artifact_moves;
--> statement-breakpoint
ALTER TABLE public.artifacts DROP COLUMN level;
--> statement-breakpoint
ALTER TABLE public.artifacts DROP COLUMN owner_id;
--> statement-breakpoint
ALTER TABLE public.artifacts DROP COLUMN guild_id;
--> statement-breakpoint
CREATE UNIQUE INDEX artifacts_natural_key ON public.artifacts USING btree (org_id, agent_id, collection_id, path, key) NULLS NOT DISTINCT WHERE (deleted_at IS NULL);
--> statement-breakpoint
-- Memory and scripts belong to one agent; notes, files, and records to the organisation alone.
ALTER TABLE public.artifacts ADD CONSTRAINT artifacts_agent_kinds CHECK ((kind IN ('memory', 'script')) = (agent_id IS NOT NULL));
--> statement-breakpoint
ALTER TABLE public.artifacts ADD CONSTRAINT artifacts_task_memory CHECK (kind <> 'memory' OR (path = '' AND key = 'memory.md'));
--> statement-breakpoint
ALTER TABLE public.artifacts ADD CONSTRAINT artifacts_kind_text CHECK (
	(kind IN ('note', 'memory') AND content_text IS NOT NULL AND content_json IS NULL AND collection_id IS NULL)
	OR (kind = 'object' AND content_json IS NOT NULL AND jsonb_typeof(content_json) = 'object' AND content_text IS NULL
	    AND collection_id IS NOT NULL AND search_blob IS NOT NULL
	    AND (search_text IS NULL OR (char_length(search_text) >= 1 AND char_length(search_text) <= 400)))
	OR (kind = 'script' AND content_text IS NOT NULL AND collection_id IS NULL AND path = 'scripts'
	    AND (content_json IS NULL OR jsonb_typeof(content_json) = 'object'))
	OR (kind = 'file' AND content_text IS NULL AND content_json IS NULL AND collection_id IS NULL AND path = 'files'
	    AND title IS NOT NULL AND search_text IS NOT NULL AND mime IS NOT NULL AND bytes IS NOT NULL AND bytes > 0)
);
--> statement-breakpoint
-- A recipe note has no level: an agent note's role writes it, a guild note's guild writes it, and an
-- organisation note keeps the guild's read it had by default.
UPDATE public.recipes r
   SET body = jsonb_set(r.body, '{notes}', (
     SELECT COALESCE(jsonb_agg(
              (e.n - 'level' - 'role')
              || CASE
                   WHEN e.n->>'level' = 'guild' THEN jsonb_build_object('guild', 'write')
                   WHEN e.n->>'level' = 'org' AND NOT (e.n ? 'guild') THEN jsonb_build_object('guild', 'read')
                   ELSE '{}'::jsonb
                 END
              || CASE
                   WHEN e.n->>'level' = 'agent' AND e.n ? 'role'
                        AND NOT (COALESCE(e.n->'writers', '[]'::jsonb) ? (e.n->>'role'))
                     THEN jsonb_build_object('writers', COALESCE(e.n->'writers', '[]'::jsonb) || to_jsonb(e.n->>'role'))
                   ELSE '{}'::jsonb
                 END
              ORDER BY e.ord), '[]'::jsonb)
       FROM jsonb_array_elements(r.body->'notes') WITH ORDINALITY AS e(n, ord)))
 WHERE jsonb_typeof(r.body->'notes') = 'array';
--> statement-breakpoint
-- A recipe names a note as `org/<key>`: the `agent/<role>/` and `guild/` paths go.
UPDATE public.recipes
   SET body = regexp_replace(body::text, '(?<![A-Za-z0-9_./-])(?:agent/[a-z][a-z0-9-]{0,62}|guild)/([^[:space:]/\\`''"()<>\[\]|]+?\.md)(?![A-Za-z0-9_-])', 'org/\1', 'g')::jsonb
 WHERE body::text ~ '(agent/[a-z][a-z0-9-]{0,62}|guild)/[^[:space:]/\\`''"()<>\[\]|]+?\.md';
--> statement-breakpoint
-- A pending apply's preview lists its notes without a level or a role.
UPDATE public.recipe_applies a
   SET preview = jsonb_set(a.preview, '{creates,notes}', (
     SELECT COALESCE(jsonb_agg((e.n - 'level' - 'role') ORDER BY e.ord), '[]'::jsonb)
       FROM jsonb_array_elements(a.preview->'creates'->'notes') WITH ORDINALITY AS e(n, ord)))
 WHERE jsonb_typeof(a.preview->'creates'->'notes') = 'array';
