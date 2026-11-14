-- Who asked for a task: free text set by the client that creates or edits it (for example an assistant
-- or a project name), so the requester can be found and told when the task changes. Nullable, additive.
ALTER TABLE "tasks" ADD COLUMN "requested_by" text;
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_requested_by_check" CHECK ("requested_by" IS NULL OR char_length(btrim("requested_by")) BETWEEN 1 AND 200);
