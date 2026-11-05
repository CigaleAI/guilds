-- A run's wake-ups: each fires once, at most one per run is pending, and the ticker reads the pending ones by due time.
CREATE TABLE public.run_wakes (
	id text PRIMARY KEY,
	run_id text NOT NULL,
	root_run_id text NOT NULL,
	agent_id text NOT NULL,
	due_at timestamp with time zone NOT NULL,
	message text,
	state text NOT NULL,
	cancel_reason text,
	set_tool_call_id text NOT NULL,
	created_at timestamp with time zone NOT NULL,
	fired_at timestamp with time zone,
	CONSTRAINT run_wakes_state_check CHECK (state IN ('pending', 'fired', 'cancelled')),
	CONSTRAINT run_wakes_cancel_reason_check CHECK (cancel_reason IN ('replaced', 'agent', 'operator', 'limit')),
	CONSTRAINT run_wakes_cancelled_has_reason CHECK ((state = 'cancelled') = (cancel_reason IS NOT NULL)),
	CONSTRAINT run_wakes_fired_has_time CHECK ((state = 'fired') = (fired_at IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE public.run_wakes ADD CONSTRAINT run_wakes_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE public.run_wakes ADD CONSTRAINT run_wakes_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.agents(id) ON DELETE CASCADE;
--> statement-breakpoint
CREATE UNIQUE INDEX run_wakes_one_pending ON public.run_wakes USING btree (run_id) WHERE (state = 'pending');
--> statement-breakpoint
CREATE INDEX run_wakes_due ON public.run_wakes USING btree (due_at) WHERE (state = 'pending');
--> statement-breakpoint
CREATE INDEX run_wakes_by_root ON public.run_wakes USING btree (root_run_id, state);
