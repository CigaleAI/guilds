-- A registry connector its publisher marks experimental keeps that mark on the box, beside verified.
ALTER TABLE public.connectors ADD COLUMN experimental boolean DEFAULT false NOT NULL;
