-- When an operator last cleared the guild's group chat; a run started before it can no longer post there.
ALTER TABLE public.guilds ADD COLUMN group_chat_cleared_at timestamptz;
