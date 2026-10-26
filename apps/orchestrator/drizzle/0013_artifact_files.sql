-- A shared file is an artifact whose bytes sit in the blob store. Its row carries the name (key), the
-- description (title), the media type, the size, and the sha256 of the bytes (content_hash).
ALTER TABLE public.artifacts ADD COLUMN mime text;
--> statement-breakpoint
ALTER TABLE public.artifacts ADD COLUMN bytes integer;
--> statement-breakpoint
ALTER TABLE public.artifacts DROP CONSTRAINT artifacts_kind_check;
--> statement-breakpoint
ALTER TABLE public.artifacts ADD CONSTRAINT artifacts_kind_check CHECK (kind IN ('note', 'object', 'memory', 'script', 'file'));
--> statement-breakpoint
ALTER TABLE public.artifacts DROP CONSTRAINT artifacts_kind_text;
--> statement-breakpoint
ALTER TABLE public.artifacts ADD CONSTRAINT artifacts_kind_text CHECK (
	(kind IN ('note', 'memory') AND content_text IS NOT NULL AND content_json IS NULL AND collection_id IS NULL)
	OR (kind = 'object' AND content_json IS NOT NULL AND jsonb_typeof(content_json) = 'object' AND content_text IS NULL
	    AND collection_id IS NOT NULL AND search_blob IS NOT NULL
	    AND (search_text IS NULL OR (char_length(search_text) >= 1 AND char_length(search_text) <= 400)))
	OR (kind = 'script' AND content_text IS NOT NULL AND collection_id IS NULL AND level = 'agent' AND path = 'scripts'
	    AND (content_json IS NULL OR jsonb_typeof(content_json) = 'object'))
	OR (kind = 'file' AND content_text IS NULL AND content_json IS NULL AND collection_id IS NULL AND path = 'files'
	    AND title IS NOT NULL AND search_text IS NOT NULL AND mime IS NOT NULL AND bytes IS NOT NULL AND bytes > 0)
);
--> statement-breakpoint
ALTER TABLE public.artifacts ADD CONSTRAINT artifacts_file_key CHECK (kind <> 'file' OR (key !~ '[/\\]' AND key NOT IN ('.', '..') AND key = btrim(key)));
--> statement-breakpoint
ALTER TABLE public.artifacts ADD CONSTRAINT artifacts_file_columns CHECK (kind = 'file' OR (mime IS NULL AND bytes IS NULL));
--> statement-breakpoint
-- A file's search document is its name and description.
ALTER TABLE public.artifacts DROP COLUMN search_document;
--> statement-breakpoint
ALTER TABLE public.artifacts ADD COLUMN search_document tsvector GENERATED ALWAYS AS (
CASE
    WHEN kind IN ('note', 'memory') THEN to_tsvector('simple', COALESCE(content_text, ''))
    WHEN kind = 'object' THEN (setweight(to_tsvector('simple', COALESCE(search_text, '')), 'A') || setweight(to_tsvector('simple', COALESCE(search_blob, '')), 'B'))
    WHEN kind = 'file' THEN to_tsvector('simple', COALESCE(search_text, ''))
    ELSE NULL::tsvector
END) STORED;
--> statement-breakpoint
CREATE INDEX artifacts_search_document ON public.artifacts USING gin (search_document);
--> statement-breakpoint
-- A file carries an access list, and a change to it is logged against the file.
ALTER TABLE public.artifact_access DROP CONSTRAINT artifact_access_target_check;
--> statement-breakpoint
ALTER TABLE public.artifact_access ADD CONSTRAINT artifact_access_target_check CHECK (target_kind IN ('note', 'collection', 'file'));
--> statement-breakpoint
ALTER TABLE public.config_changes DROP CONSTRAINT config_changes_target_kind_check;
--> statement-breakpoint
ALTER TABLE public.config_changes ADD CONSTRAINT config_changes_target_kind_check CHECK (target_kind IN ('routine', 'access', 'guild_text', 'collection', 'note', 'file'));
