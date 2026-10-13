CREATE TABLE public.machines (
	id text PRIMARY KEY,
	org_id text NOT NULL,
	name text NOT NULL,
	box text NOT NULL,
	cpu numeric,
	memory_mib integer,
	max_workspace_mib integer NOT NULL DEFAULT 10240,
	workspace_mib integer,
	created_at timestamp with time zone NOT NULL,
	updated_at timestamp with time zone NOT NULL,
	CONSTRAINT machines_org_id_name_key UNIQUE (org_id, name),
	CONSTRAINT machines_org_id_id_unique UNIQUE (org_id, id),
	CONSTRAINT machines_box_check CHECK (box IN ('standard', 'code', 'custom')),
	CONSTRAINT machines_size_check CHECK (
		(box = 'custom' AND cpu IS NOT NULL AND memory_mib IS NOT NULL)
		OR (box <> 'custom' AND cpu IS NULL AND memory_mib IS NULL)
	),
	CONSTRAINT machines_max_workspace_mib_positive CHECK (max_workspace_mib > 0)
);
--> statement-breakpoint
ALTER TABLE public.machines ADD CONSTRAINT machines_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE public.agents ADD COLUMN machine_id text;
--> statement-breakpoint
ALTER TABLE public.agents ADD COLUMN machine_slot smallint;
--> statement-breakpoint
-- Places every agent on a machine of its organisation. Every organisation gets a standard machine
-- named `default`, which holds the agents whose box is lite (`default-2`, `default-3`... past 32
-- of them); every other agent gets a machine of its own, named after it, with its box and size.
DO $$
DECLARE
	org record;
	agent record;
	effective_box text;
	machine text;
	candidate text;
	suffix integer;
	lite_count integer;
	lite_index integer;
	stamp timestamp with time zone := now();
BEGIN
	FOR org IN SELECT id FROM public.orgs ORDER BY created_at, id LOOP
		machine := 'mach_' || upper(substr(md5(random()::text || clock_timestamp()::text || org.id), 1, 26));
		INSERT INTO public.machines (id, org_id, name, box, created_at, updated_at)
		VALUES (machine, org.id, 'default', 'standard', stamp, stamp);
		lite_count := 0;
		lite_index := 1;
		FOR agent IN
			SELECT id, config FROM public.agents
			 WHERE org_id = org.id
			   AND COALESCE(
				config->>'box',
				CASE WHEN config->>'coding' = 'true' THEN 'code'
				     WHEN config->>'browser' = 'true' THEN 'standard'
				     ELSE 'lite' END
			   ) = 'lite'
			 ORDER BY created_at, id
		LOOP
			IF lite_count >= 32 THEN
				lite_index := lite_index + 1;
				lite_count := 0;
				machine := 'mach_' || upper(substr(md5(random()::text || clock_timestamp()::text || agent.id), 1, 26));
				INSERT INTO public.machines (id, org_id, name, box, created_at, updated_at)
				VALUES (machine, org.id, 'default-' || lite_index, 'standard', stamp, stamp);
			END IF;
			UPDATE public.agents SET machine_id = machine, machine_slot = lite_count WHERE id = agent.id;
			lite_count := lite_count + 1;
		END LOOP;
		FOR agent IN
			SELECT id, name, config FROM public.agents
			 WHERE org_id = org.id AND machine_id IS NULL
			 ORDER BY created_at, id
		LOOP
			effective_box := COALESCE(
				agent.config->>'box',
				CASE WHEN agent.config->>'coding' = 'true' THEN 'code' ELSE 'standard' END
			);
			IF effective_box = 'custom' AND NOT (
				jsonb_typeof(agent.config->'cpu') IS NOT DISTINCT FROM 'number'
				AND jsonb_typeof(agent.config->'memory_mib') IS NOT DISTINCT FROM 'number'
			) THEN
				effective_box := CASE WHEN agent.config->>'coding' = 'true' THEN 'code' ELSE 'standard' END;
			END IF;
			candidate := agent.name;
			suffix := 2;
			WHILE EXISTS (SELECT 1 FROM public.machines m WHERE m.org_id = org.id AND m.name = candidate) LOOP
				candidate := left(agent.name, 63 - length('-' || suffix)) || '-' || suffix;
				suffix := suffix + 1;
			END LOOP;
			machine := 'mach_' || upper(substr(md5(random()::text || clock_timestamp()::text || agent.id), 1, 26));
			INSERT INTO public.machines (id, org_id, name, box, cpu, memory_mib, created_at, updated_at)
			VALUES (
				machine, org.id, candidate, effective_box,
				CASE WHEN effective_box = 'custom' THEN (agent.config->>'cpu')::numeric END,
				CASE WHEN effective_box = 'custom' THEN (agent.config->>'memory_mib')::numeric::integer END,
				stamp, stamp
			);
			UPDATE public.agents SET machine_id = machine, machine_slot = 0 WHERE id = agent.id;
		END LOOP;
	END LOOP;
END $$;
--> statement-breakpoint
UPDATE public.machines m
   SET max_workspace_mib = GREATEST(10240, used.mib + 1024)
  FROM (
	SELECT machine_id, SUM(workspace_mib)::integer AS mib
	  FROM public.agents
	 WHERE workspace_mib IS NOT NULL
	 GROUP BY machine_id
  ) used
 WHERE used.machine_id = m.id;
--> statement-breakpoint
UPDATE public.agents SET config = config - 'box' - 'cpu' - 'memory_mib';
--> statement-breakpoint
UPDATE public.runs
   SET config_snapshot = config_snapshot - 'box' - 'cpu' - 'memory_mib'
 WHERE status = 'active' AND archived_at IS NULL;
--> statement-breakpoint
ALTER TABLE public.agents ALTER COLUMN machine_id SET NOT NULL;
--> statement-breakpoint
ALTER TABLE public.agents ALTER COLUMN machine_slot SET NOT NULL;
--> statement-breakpoint
ALTER TABLE public.agents ADD CONSTRAINT agents_machine_slot_range CHECK (machine_slot >= 0 AND machine_slot < 32);
--> statement-breakpoint
ALTER TABLE public.agents ADD CONSTRAINT agents_machine_slot_key UNIQUE (machine_id, machine_slot);
--> statement-breakpoint
ALTER TABLE public.agents ADD CONSTRAINT agents_machine_fkey FOREIGN KEY (org_id, machine_id) REFERENCES public.machines(org_id, id) ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX agents_by_machine ON public.agents USING btree (machine_id);
