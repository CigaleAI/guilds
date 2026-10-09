-- Every agent runs on one of two boxes. A row that predates the key takes the box its flags call
-- for: standard with browser or coding on, lite otherwise.
UPDATE public.agents
SET config = config || jsonb_build_object(
    'box',
    CASE
        WHEN config->'browser' = 'true'::jsonb OR config->'coding' = 'true'::jsonb THEN 'standard'
        ELSE 'lite'
    END
)
WHERE NOT (config ? 'box');
