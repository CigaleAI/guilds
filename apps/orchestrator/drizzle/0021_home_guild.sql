-- A note's or a file's home guild is `origin_guild_id`: a guild of its organisation, or none.
-- A value that names no guild of the item's organisation becomes none.
UPDATE public.artifacts a
   SET origin_guild_id = NULL
 WHERE a.origin_guild_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.guilds g WHERE g.id = a.origin_guild_id AND g.org_id = a.org_id);
--> statement-breakpoint
-- A live or deleted note or file without a home takes it from its access list when the list has no
-- organisation row and every row names the same one guild: a guild row names its guild, an agent
-- row the guild its agent sits in. A row at `none` names no one; an agent row whose agent is gone
-- names no guild. Any other list leaves the item without a home.
UPDATE public.artifacts a
   SET origin_guild_id = h.guild_id
  FROM (
    SELECT t.id,
           CASE
             WHEN count(*) FILTER (WHERE x.subject_type = 'org') = 0
                  AND count(*) FILTER (WHERE x.subject_type = 'agent' AND ag.id IS NULL) = 0
                  AND count(DISTINCT CASE WHEN x.subject_type = 'guild' THEN x.subject_id ELSE ag.guild_id END) = 1
               THEN min(CASE WHEN x.subject_type = 'guild' THEN x.subject_id ELSE ag.guild_id END)
           END AS guild_id
      FROM public.artifacts t
      JOIN public.artifact_access x ON x.target_kind = t.kind AND x.target_id = t.id AND x.mode <> 'none'
      LEFT JOIN public.agents ag ON x.subject_type = 'agent' AND ag.id = x.subject_id
     WHERE t.kind IN ('note', 'file') AND t.origin_guild_id IS NULL
     GROUP BY t.id
  ) h
 WHERE h.id = a.id
   AND EXISTS (SELECT 1 FROM public.guilds g WHERE g.id = h.guild_id AND g.org_id = a.org_id);
--> statement-breakpoint
ALTER TABLE public.artifacts ADD CONSTRAINT artifacts_origin_guild_id_fkey FOREIGN KEY (origin_guild_id) REFERENCES public.guilds(id) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX artifacts_by_origin_guild ON public.artifacts USING btree (origin_guild_id, org_id);
--> statement-breakpoint
DROP TABLE public.artifact_renames;
