-- System One replaces the group routing key: a box with the key set keeps it under the new id.
UPDATE public.instance_keys SET integration = 'system-one' WHERE integration = 'group-routing';
