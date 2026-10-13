-- The coding harness CLIs the machine's image carries, read when its container starts; null until it first has.
ALTER TABLE public.machines ADD COLUMN harnesses text[];
