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
-- An agent-level note or file has a row for its agent at write.
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
-- A tombstone keeps its rows, so a deleted guild- or agent-level note or file has a row for its
-- guild or its agent at write, and stays hidden from whom its live self was hidden from.
INSERT INTO public.artifact_access (
	id, org_id, target_kind, target_id, subject_type, subject_id, mode,
	created_by_type, created_by_id, created_by_name, created_at,
	updated_by_type, updated_by_id, updated_by_name, updated_at
)
SELECT 'aacc_' || upper(substr(md5(random()::text || clock_timestamp()::text || a.id), 1, 26)),
       a.org_id, a.kind, a.id, a.level, a.owner_id, 'write',
       a.created_by_type, a.created_by_id, a.created_by_name, a.created_at,
       a.created_by_type, a.created_by_id, a.created_by_name, a.created_at
  FROM public.artifacts a
 WHERE a.kind IN ('note', 'file') AND a.level IN ('guild', 'agent') AND a.deleted_at IS NOT NULL
ON CONFLICT (target_kind, target_id, subject_type, subject_id) DO NOTHING;
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
-- Paths that moved, by the organisation or recipe they are rewritten in. A text is rewritten in two
-- passes, every old path to its token then every token to its new path, so a new path that is
-- another item's old one is not rewritten again.
CREATE TEMPORARY TABLE path_moves (scope text NOT NULL, token text NOT NULL, old_path text NOT NULL, new_path text NOT NULL);
--> statement-breakpoint
-- `body` with each whole occurrence of `old_path` replaced by `new_path`: the character before it
-- is not part of a path, and the character after it neither continues the path nor is a dot that
-- starts a longer name (`a.csv` inside `a.csv.gz`).
CREATE FUNCTION pg_temp.replace_path(body text, old_path text, new_path text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  done text := '';
  rest text := body;
  at integer;
  before text;
  after text;
  beyond text;
BEGIN
  IF body IS NULL THEN
    RETURN NULL;
  END IF;
  LOOP
    at := strpos(rest, old_path);
    EXIT WHEN at = 0;
    before := CASE WHEN at > 1 THEN substr(rest, at - 1, 1) ELSE right(done, 1) END;
    after := substr(rest, at + length(old_path), 1);
    beyond := substr(rest, at + length(old_path) + 1, 1);
    IF before !~ '[A-Za-z0-9_./-]' AND after !~ '[A-Za-z0-9_/-]' AND NOT (after = '.' AND beyond ~ '[A-Za-z0-9_-]') THEN
      done := done || substr(rest, 1, at - 1) || new_path;
      rest := substr(rest, at + length(old_path));
    ELSE
      done := done || substr(rest, 1, at);
      rest := substr(rest, at + 1);
    END IF;
  END LOOP;
  RETURN done || rest;
END $$;
--> statement-breakpoint
-- `body` with every path that moved in `at_scope` rewritten, longest first, through its token.
CREATE FUNCTION pg_temp.rewrite_paths(body text, at_scope text) RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE
  moved record;
  result text := body;
BEGIN
  IF body IS NULL THEN
    RETURN NULL;
  END IF;
  FOR moved IN SELECT * FROM path_moves WHERE scope = at_scope ORDER BY length(old_path) DESC, old_path LOOP
    IF strpos(result, moved.old_path) > 0 THEN
      result := pg_temp.replace_path(result, moved.old_path, moved.token);
    END IF;
  END LOOP;
  FOR moved IN SELECT * FROM path_moves WHERE scope = at_scope LOOP
    result := replace(result, moved.token, moved.new_path);
  END LOOP;
  RETURN result;
END $$;
--> statement-breakpoint
-- A recipe's `agent/<role>/<key>` and `guild/<key>` note paths, written as `org/<key>`.
CREATE FUNCTION pg_temp.collapse_recipe_paths(body text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT regexp_replace(body, '(?<![A-Za-z0-9_./-])(?:agent/[a-z][a-z0-9-]{0,62}|guild)/([^[:space:]/\\`''"()<>\[\]|]+?\.md)(?![A-Za-z0-9_-])', 'org/\1', 'g')
$$;
--> statement-breakpoint
-- A JSON value with every string in it rewritten as `rewrite_paths` does, and as
-- `collapse_recipe_paths` does too when `collapse`; strings are rewritten decoded, not as JSON text.
CREATE FUNCTION pg_temp.rewrite_json(j jsonb, at_scope text, collapse boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$
DECLARE
  text_value text;
BEGIN
  CASE jsonb_typeof(j)
    WHEN 'string' THEN
      text_value := pg_temp.rewrite_paths(j #>> '{}', at_scope);
      RETURN to_jsonb(CASE WHEN collapse THEN pg_temp.collapse_recipe_paths(text_value) ELSE text_value END);
    WHEN 'array' THEN
      RETURN COALESCE(
        (SELECT jsonb_agg(pg_temp.rewrite_json(e, at_scope, collapse) ORDER BY i)
           FROM jsonb_array_elements(j) WITH ORDINALITY AS t(e, i)),
        '[]'::jsonb);
    WHEN 'object' THEN
      RETURN COALESCE(
        (SELECT jsonb_object_agg(k, pg_temp.rewrite_json(v, at_scope, collapse)) FROM jsonb_each(j) AS t(k, v)),
        '{}'::jsonb);
    ELSE
      RETURN j;
  END CASE;
END $$;
--> statement-breakpoint
INSERT INTO path_moves (scope, token, old_path, new_path)
SELECT org_id, chr(1) || id || chr(2), old_display_path, new_display_path
  FROM artifact_moves
 WHERE old_display_path <> new_display_path;
--> statement-breakpoint
-- Every embed and every mention of a moved item's old display path names its new one.
UPDATE public.agents a
   SET task = r.task, task_hash = encode(sha256(convert_to(r.task, 'UTF8')), 'hex')
  FROM (SELECT id, pg_temp.rewrite_paths(task, org_id) AS task FROM public.agents) r
 WHERE r.id = a.id AND r.task <> a.task;
--> statement-breakpoint
-- What an agent reads at run time besides its Task: its peers' focus and wake triggers, its
-- routines' instructions and descriptions, and its guild's about and description.
UPDATE public.agents a
   SET focus = r.focus, wake_triggers = r.wake_triggers
  FROM (SELECT id, pg_temp.rewrite_paths(focus, org_id) AS focus, pg_temp.rewrite_paths(wake_triggers, org_id) AS wake_triggers
          FROM public.agents) r
 WHERE r.id = a.id AND (r.focus <> a.focus OR r.wake_triggers <> a.wake_triggers);
--> statement-breakpoint
UPDATE public.schedules s
   SET instruction = r.instruction, description = r.description
  FROM (SELECT sc.id, pg_temp.rewrite_paths(sc.instruction, ag.org_id) AS instruction,
               pg_temp.rewrite_paths(sc.description, ag.org_id) AS description
          FROM public.schedules sc JOIN public.agents ag ON ag.id = sc.agent_id) r
 WHERE r.id = s.id AND (r.instruction <> s.instruction OR r.description <> s.description);
--> statement-breakpoint
UPDATE public.guilds g
   SET about = r.about, description = r.description
  FROM (SELECT id, pg_temp.rewrite_paths(about, org_id) AS about, pg_temp.rewrite_paths(description, org_id) AS description
          FROM public.guilds) r
 WHERE r.id = g.id AND (r.about <> g.about OR r.description <> g.description);
--> statement-breakpoint
UPDATE public.task_revisions t
   SET content_text = r.content_text
  FROM (SELECT id, pg_temp.rewrite_paths(content_text, org_id) AS content_text FROM public.task_revisions) r
 WHERE r.id = t.id AND r.content_text <> t.content_text;
--> statement-breakpoint
UPDATE public.artifacts a
   SET content_text = r.content_text, content_hash = encode(sha256(convert_to(r.content_text, 'UTF8')), 'hex')
  FROM (SELECT id, pg_temp.rewrite_paths(content_text, org_id) AS content_text
          FROM public.artifacts WHERE kind IN ('note', 'memory') AND content_text IS NOT NULL) r
 WHERE r.id = a.id AND r.content_text <> a.content_text;
--> statement-breakpoint
UPDATE public.recipes r
   SET body = pg_temp.rewrite_json(r.body, r.org_id, false)
 WHERE strpos(r.body::text, 'org/' || r.org_id || '/') > 0;
--> statement-breakpoint
-- A Studio draft of a moved item names the item's new display path.
UPDATE public.studio_drafts d
   SET source_display_path = m.new_display_path
  FROM artifact_moves m
 WHERE d.source_artifact_id = m.id AND d.source_display_path IS DISTINCT FROM m.new_display_path;
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
-- A recipe's notes become one per key: the first note of a key keeps it, each later one takes its
-- role's name (`agent` without one, `guild`, or `org`) as a prefix, numbered when that is taken too,
-- and every path the recipe names it by follows it.
DO $$
DECLARE
  recipe record;
  note record;
  originals text[];
  assigned text[];
  prefix text;
  candidate text;
  n integer;
  notes jsonb;
BEGIN
  FOR recipe IN SELECT id, body FROM public.recipes WHERE jsonb_typeof(body->'notes') = 'array' LOOP
    originals := ARRAY(SELECT e->>'key' FROM jsonb_array_elements(recipe.body->'notes') AS t(e));
    assigned := ARRAY[]::text[];
    notes := '[]'::jsonb;
    FOR note IN SELECT e AS n, ord FROM jsonb_array_elements(recipe.body->'notes') WITH ORDINALITY AS t(e, ord) ORDER BY ord LOOP
      candidate := note.n->>'key';
      IF candidate = ANY (assigned) THEN
        prefix := CASE note.n->>'level'
          WHEN 'agent' THEN COALESCE(NULLIF(note.n->>'role', ''), 'agent')
          WHEN 'guild' THEN 'guild'
          ELSE 'org'
        END;
        candidate := prefix || '-' || (note.n->>'key');
        n := 1;
        WHILE candidate = ANY (assigned) OR candidate = ANY (originals) LOOP
          n := n + 1;
          candidate := prefix || '-' || n || '-' || (note.n->>'key');
        END LOOP;
      END IF;
      assigned := assigned || candidate;
      INSERT INTO path_moves (scope, token, old_path, new_path)
      SELECT 'recipe:' || recipe.id, chr(1) || 'note' || note.ord || chr(2), old_path, 'org/' || candidate
        FROM (SELECT CASE note.n->>'level'
                       WHEN 'agent' THEN 'agent/' || COALESCE(NULLIF(note.n->>'role', ''), '_') || '/' || (note.n->>'key')
                       WHEN 'guild' THEN 'guild/' || (note.n->>'key')
                       ELSE 'org/' || (note.n->>'key')
                     END AS old_path) p
       WHERE old_path <> 'org/' || candidate;
      notes := notes || jsonb_build_array(jsonb_set(note.n, '{key}', to_jsonb(candidate)));
    END LOOP;
    UPDATE public.recipes SET body = jsonb_set(body, '{notes}', notes) WHERE id = recipe.id;
  END LOOP;
END $$;
--> statement-breakpoint
-- A recipe note has no level: an agent note's role writes it, a guild note's guild writes it, and an
-- organisation note keeps the organisation's and the guild's read it had by default.
UPDATE public.recipes r
   SET body = jsonb_set(r.body, '{notes}', (
     SELECT COALESCE(jsonb_agg(
              (e.n - 'level' - 'role')
              || CASE
                   WHEN e.n->>'level' = 'guild' THEN jsonb_build_object('guild', 'write')
                   WHEN e.n->>'level' = 'org' AND NOT (e.n ? 'guild') THEN jsonb_build_object('guild', 'read', 'org', 'read')
                   WHEN e.n->>'level' = 'org' THEN jsonb_build_object('org', 'read')
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
-- A recipe names a note as `org/<key>`: each renamed note's paths follow it, then the remaining
-- `agent/<role>/` and `guild/` paths go, in every string of the recipe as it reads decoded.
UPDATE public.recipes r
   SET body = pg_temp.rewrite_json(r.body, 'recipe:' || r.id, true)
 WHERE r.body::text ~ '(agent/[a-z][a-z0-9-]{0,62}|guild)/'
    OR EXISTS (SELECT 1 FROM path_moves m WHERE m.scope = 'recipe:' || r.id);
--> statement-breakpoint
-- A pending apply's preview lists its notes without a level or a role.
UPDATE public.recipe_applies a
   SET preview = jsonb_set(a.preview, '{creates,notes}', (
     SELECT COALESCE(jsonb_agg((e.n - 'level' - 'role') ORDER BY e.ord), '[]'::jsonb)
       FROM jsonb_array_elements(a.preview->'creates'->'notes') WITH ORDINALITY AS e(n, ord)))
 WHERE jsonb_typeof(a.preview->'creates'->'notes') = 'array';
--> statement-breakpoint
DROP FUNCTION pg_temp.rewrite_json(jsonb, text, boolean);
--> statement-breakpoint
DROP FUNCTION pg_temp.collapse_recipe_paths(text);
--> statement-breakpoint
DROP FUNCTION pg_temp.rewrite_paths(text, text);
--> statement-breakpoint
DROP FUNCTION pg_temp.replace_path(text, text, text);
--> statement-breakpoint
DROP TABLE path_moves;
