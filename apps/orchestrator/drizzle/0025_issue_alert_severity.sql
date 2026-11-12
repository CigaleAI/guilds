-- The least severe issue a user is alerted to. `low` alerts them to every issue.
ALTER TABLE public.users ADD COLUMN issue_alert_severity text DEFAULT 'low'::text NOT NULL;
--> statement-breakpoint
ALTER TABLE public.users ADD CONSTRAINT users_issue_alert_severity_check CHECK ((issue_alert_severity = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text, 'blocking'::text])));
