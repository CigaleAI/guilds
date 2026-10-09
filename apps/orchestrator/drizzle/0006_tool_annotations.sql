-- A listed tool keeps the annotations its server's tools/list gave it, null when absent: they
-- decide whether it starts Off and whether Studio may read through it.
ALTER TABLE public.mcp_tools ADD COLUMN read_only_hint boolean;
--> statement-breakpoint
ALTER TABLE public.mcp_tools ADD COLUMN destructive_hint boolean;
