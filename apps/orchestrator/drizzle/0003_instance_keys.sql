CREATE TABLE public.instance_keys (
	integration text PRIMARY KEY,
	ciphertext bytea NOT NULL,
	nonce bytea NOT NULL,
	set_by_user_id text,
	created_at timestamp with time zone NOT NULL,
	updated_at timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE public.instance_keys ADD CONSTRAINT instance_keys_set_by_user_id_fkey FOREIGN KEY (set_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;
