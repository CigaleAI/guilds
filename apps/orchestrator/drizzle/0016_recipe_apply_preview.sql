-- An apply always records the preview it was made from.
ALTER TABLE public.recipe_applies ALTER COLUMN preview DROP DEFAULT;
