-- The earlier public message in the same guild that a reply answers.
ALTER TABLE public.group_messages ADD COLUMN reply_to_seq bigint;
--> statement-breakpoint
ALTER TABLE public.group_messages ADD CONSTRAINT group_messages_reply_to_seq_fkey FOREIGN KEY (guild_id, reply_to_seq) REFERENCES public.group_messages(guild_id, seq) ON DELETE CASCADE;
