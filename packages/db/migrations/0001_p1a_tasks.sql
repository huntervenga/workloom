CREATE TYPE "public"."task_participant_role" AS ENUM('assignee');--> statement-breakpoint
CREATE TYPE "public"."task_priority" AS ENUM('none', 'low', 'medium', 'high', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."task_status_group" AS ENUM('todo', 'in_progress', 'done', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."task_visibility" AS ENUM('workspace');--> statement-breakpoint
CREATE TYPE "public"."work_package_origin" AS ENUM('new_task', 'added_scope');--> statement-breakpoint
CREATE TABLE "command_idempotency" (
	"workspace_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"command" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload_hash" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "command_idempotency_pk" PRIMARY KEY("workspace_id","actor_user_id","command","idempotency_key"),
	CONSTRAINT "command_idempotency_command_length" CHECK (char_length(command) between 1 and 80),
	CONSTRAINT "command_idempotency_key_format" CHECK (idempotency_key ~ '^[ -~]{1,128}$'),
	CONSTRAINT "command_idempotency_payload_hash_format" CHECK (payload_hash ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "projects_name_length" CHECK (char_length(btrim(name)) between 1 and 160),
	CONSTRAINT "projects_revision_positive" CHECK (revision >= 1)
);
--> statement-breakpoint
CREATE TABLE "sections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "sections_workspace_project_id_unique" UNIQUE("workspace_id","project_id","id"),
	CONSTRAINT "sections_name_length" CHECK (char_length(btrim(name)) between 1 and 160),
	CONSTRAINT "sections_position_nonnegative" CHECK (position >= 0),
	CONSTRAINT "sections_revision_positive" CHECK (revision >= 1)
);
--> statement-breakpoint
CREATE TABLE "task_participants" (
	"workspace_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"role" "task_participant_role" DEFAULT 'assignee' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_participants_pk" PRIMARY KEY("workspace_id","task_id","membership_id"),
	CONSTRAINT "task_participants_revision_positive" CHECK (revision >= 1)
);
--> statement-breakpoint
CREATE TABLE "task_statuses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"group" "task_status_group" NOT NULL,
	"position" integer NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "task_statuses_workspace_project_id_unique" UNIQUE("workspace_id","project_id","id"),
	CONSTRAINT "task_statuses_name_length" CHECK (char_length(btrim(name)) between 1 and 160),
	CONSTRAINT "task_statuses_position_nonnegative" CHECK (position >= 0),
	CONSTRAINT "task_statuses_revision_positive" CHECK (revision >= 1)
);
--> statement-breakpoint
CREATE TABLE "task_tags" (
	"workspace_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	CONSTRAINT "task_tags_pk" PRIMARY KEY("workspace_id","task_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"section_id" uuid,
	"parent_task_id" uuid,
	"work_package_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status_id" uuid NOT NULL,
	"responsible_membership_id" uuid,
	"participants_revision" integer DEFAULT 1 NOT NULL,
	"due_date" date,
	"priority" "task_priority" DEFAULT 'none' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"position" integer NOT NULL,
	"visibility" "task_visibility" DEFAULT 'workspace' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "tasks_workspace_project_id_unique" UNIQUE("workspace_id","project_id","id"),
	CONSTRAINT "tasks_parent_not_self" CHECK (parent_task_id is null or parent_task_id <> id),
	CONSTRAINT "tasks_title_length" CHECK (char_length(btrim(title)) between 1 and 500),
	CONSTRAINT "tasks_description_length" CHECK (char_length(description) <= 20000),
	CONSTRAINT "tasks_position_nonnegative" CHECK (position >= 0),
	CONSTRAINT "tasks_revision_positive" CHECK (revision >= 1),
	CONSTRAINT "tasks_participants_revision_positive" CHECK (participants_revision >= 1)
);
--> statement-breakpoint
CREATE TABLE "work_packages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"origin" "work_package_origin" NOT NULL,
	"source_package_id" uuid,
	"estimate_minutes" integer,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_packages_workspace_project_id_unique" UNIQUE("workspace_id","project_id","id"),
	CONSTRAINT "work_packages_source_matches_origin" CHECK ((origin = 'new_task') = (source_package_id is null)),
	CONSTRAINT "work_packages_source_not_self" CHECK (source_package_id is null or source_package_id <> id),
	CONSTRAINT "work_packages_estimate_nonnegative" CHECK (estimate_minutes is null or estimate_minutes >= 0),
	CONSTRAINT "work_packages_revision_positive" CHECK (revision >= 1)
);
--> statement-breakpoint
CREATE TABLE "workspace_tags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "workspace_tags_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "workspace_tags_name_length" CHECK (char_length(btrim(name)) between 1 and 80),
	CONSTRAINT "workspace_tags_color_hex" CHECK (color is null or color ~ '^#[0-9A-Fa-f]{6}$'),
	CONSTRAINT "workspace_tags_revision_positive" CHECK (revision >= 1)
);
--> statement-breakpoint
ALTER TABLE "command_idempotency" ADD CONSTRAINT "command_idempotency_actor_membership_fk" FOREIGN KEY ("workspace_id","actor_user_id") REFERENCES "public"."memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sections" ADD CONSTRAINT "sections_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_participants" ADD CONSTRAINT "task_participants_task_fk" FOREIGN KEY ("workspace_id","task_id") REFERENCES "public"."tasks"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_participants" ADD CONSTRAINT "task_participants_membership_fk" FOREIGN KEY ("workspace_id","membership_id") REFERENCES "public"."memberships"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_statuses" ADD CONSTRAINT "task_statuses_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_tags" ADD CONSTRAINT "task_tags_task_fk" FOREIGN KEY ("workspace_id","task_id") REFERENCES "public"."tasks"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_tags" ADD CONSTRAINT "task_tags_tag_fk" FOREIGN KEY ("workspace_id","tag_id") REFERENCES "public"."workspace_tags"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_fk" FOREIGN KEY ("workspace_id","project_id","parent_task_id") REFERENCES "public"."tasks"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_section_fk" FOREIGN KEY ("workspace_id","project_id","section_id") REFERENCES "public"."sections"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_status_fk" FOREIGN KEY ("workspace_id","project_id","status_id") REFERENCES "public"."task_statuses"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_work_package_fk" FOREIGN KEY ("workspace_id","project_id","work_package_id") REFERENCES "public"."work_packages"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_responsible_membership_fk" FOREIGN KEY ("workspace_id","responsible_membership_id") REFERENCES "public"."memberships"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_packages" ADD CONSTRAINT "work_packages_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_packages" ADD CONSTRAINT "work_packages_source_package_fk" FOREIGN KEY ("workspace_id","project_id","source_package_id") REFERENCES "public"."work_packages"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_tags" ADD CONSTRAINT "workspace_tags_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_participants_membership_idx" ON "task_participants" USING btree ("workspace_id","membership_id","active");--> statement-breakpoint
CREATE INDEX "task_tags_tag_idx" ON "task_tags" USING btree ("workspace_id","tag_id","task_id");--> statement-breakpoint
CREATE INDEX "tasks_project_position_idx" ON "tasks" USING btree ("workspace_id","project_id","position","id");--> statement-breakpoint
CREATE INDEX "tasks_status_idx" ON "tasks" USING btree ("workspace_id","project_id","status_id");--> statement-breakpoint
CREATE INDEX "tasks_parent_idx" ON "tasks" USING btree ("workspace_id","project_id","parent_task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_tags_workspace_name_unique_idx" ON "workspace_tags" USING btree ("workspace_id",lower(name));