ALTER TABLE "memberships" ADD CONSTRAINT "memberships_workspace_id_user_unique" UNIQUE("workspace_id","id","user_id");
--> statement-breakpoint
CREATE TABLE "task_comments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"author_user_id" uuid NOT NULL,
	"author_membership_id" uuid NOT NULL,
	"author_display_name_snapshot" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"body" text NOT NULL,
	CONSTRAINT "task_comments_body_length" CHECK (char_length(body) between 1 and 4000 and body ~ '[^[:space:]]'),
	CONSTRAINT "task_comments_author_label_length" CHECK (char_length(btrim(author_display_name_snapshot)) between 1 and 200),
	CONSTRAINT "task_comments_created_at_finite" CHECK (isfinite(created_at))
);
--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_task_fk" FOREIGN KEY ("workspace_id","task_id") REFERENCES "public"."tasks"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_author_fk" FOREIGN KEY ("workspace_id","author_membership_id","author_user_id") REFERENCES "public"."memberships"("workspace_id","id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_comments_timeline_idx" ON "task_comments" USING btree ("workspace_id","task_id","created_at","id");
--> statement-breakpoint
CREATE FUNCTION "public"."workloom_reject_task_comment_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'task_comments rows are immutable' USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "task_comments_immutable_rows" BEFORE UPDATE OR DELETE ON "public"."task_comments" FOR EACH ROW EXECUTE FUNCTION "public"."workloom_reject_task_comment_mutation"();
--> statement-breakpoint
CREATE TRIGGER "task_comments_immutable_truncate" BEFORE TRUNCATE ON "public"."task_comments" FOR EACH STATEMENT EXECUTE FUNCTION "public"."workloom_reject_task_comment_mutation"();
