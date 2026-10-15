-- P0: synthetic identities, workspaces, memberships and the write-protocol foundation
-- (workspace barrier counters, immutable audit events, transactional outbox).
-- Reviewed SQL; applied only by `npm run db:migrate`, never at application startup.
-- Drizzle's migrator runs every pending migration inside one transaction.
CREATE TYPE "public"."command_source" AS ENUM('web', 'api', 'mcp', 'job', 'import');--> statement-breakpoint
CREATE TYPE "public"."membership_state" AS ENUM('active', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."user_kind" AS ENUM('fixture');--> statement-breakpoint
CREATE TYPE "public"."workspace_role" AS ENUM('owner', 'admin', 'member', 'viewer');--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"change_seq" bigint NOT NULL,
	"event_ordinal" integer NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"actor_membership_id" uuid NOT NULL,
	"source" "command_source" NOT NULL,
	"request_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"entity_revision" integer,
	"action" text NOT NULL,
	"diff" jsonb,
	"reason" text,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "audit_events_workspace_seq_ordinal_unique" UNIQUE("workspace_id","change_seq","event_ordinal"),
	CONSTRAINT "audit_events_change_seq_positive" CHECK (change_seq >= 1),
	CONSTRAINT "audit_events_event_ordinal_positive" CHECK (event_ordinal >= 1),
	CONSTRAINT "audit_events_schema_version_positive" CHECK (schema_version >= 1),
	CONSTRAINT "audit_events_entity_revision_positive" CHECK (entity_revision is null or entity_revision >= 1),
	CONSTRAINT "audit_events_labels_length" CHECK (char_length(entity_type) between 1 and 64 and char_length(action) between 1 and 64 and char_length(request_id) between 1 and 128)
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "workspace_role" NOT NULL,
	"state" "membership_state" DEFAULT 'active' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_workspace_user_unique" UNIQUE("workspace_id","user_id"),
	CONSTRAINT "memberships_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "memberships_revision_positive" CHECK (revision >= 1),
	CONSTRAINT "memberships_revoked_at_matches_state" CHECK ((state = 'revoked') = (revoked_at is not null))
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"change_seq" bigint NOT NULL,
	"event_ordinal" integer NOT NULL,
	"type" text NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"aggregate_revision" integer,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"dispatched_at" timestamp with time zone,
	CONSTRAINT "outbox_events_workspace_seq_ordinal_unique" UNIQUE("workspace_id","change_seq","event_ordinal"),
	CONSTRAINT "outbox_events_change_seq_positive" CHECK (change_seq >= 1),
	CONSTRAINT "outbox_events_event_ordinal_positive" CHECK (event_ordinal >= 1),
	CONSTRAINT "outbox_events_schema_version_positive" CHECK (schema_version >= 1),
	CONSTRAINT "outbox_events_aggregate_revision_positive" CHECK (aggregate_revision is null or aggregate_revision >= 1),
	CONSTRAINT "outbox_events_labels_length" CHECK (char_length(type) between 1 and 128 and char_length(aggregate_type) between 1 and 64)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"kind" "user_kind" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_display_name_length" CHECK (char_length(btrim(display_name)) between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"timezone" text NOT NULL,
	"week_start" smallint DEFAULT 1 NOT NULL,
	"change_seq" bigint DEFAULT 0 NOT NULL,
	"permission_epoch" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_name_length" CHECK (char_length(btrim(name)) between 1 and 200),
	CONSTRAINT "workspaces_timezone_format" CHECK (char_length(timezone) <= 64 and timezone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$'),
	CONSTRAINT "workspaces_week_start_iso_weekday" CHECK (week_start between 1 and 7),
	CONSTRAINT "workspaces_change_seq_nonnegative" CHECK (change_seq >= 0),
	CONSTRAINT "workspaces_permission_epoch_nonnegative" CHECK (permission_epoch >= 0)
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_membership_fk" FOREIGN KEY ("workspace_id","actor_membership_id") REFERENCES "public"."memberships"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_entity_idx" ON "audit_events" USING btree ("workspace_id","entity_type","entity_id","change_seq");--> statement-breakpoint
CREATE INDEX "memberships_user_active_idx" ON "memberships" USING btree ("user_id") WHERE state = 'active';--> statement-breakpoint
CREATE INDEX "outbox_events_pending_idx" ON "outbox_events" USING btree ("occurred_at","id") WHERE dispatched_at is null;--> statement-breakpoint
-- Hand-written (not expressible in Drizzle): audit history is append-only for the runtime role.
CREATE FUNCTION "public"."workloom_reject_audit_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'audit_events rows are immutable' USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "audit_events_immutable_rows" BEFORE UPDATE OR DELETE ON "audit_events" FOR EACH ROW EXECUTE FUNCTION "public"."workloom_reject_audit_mutation"();--> statement-breakpoint
CREATE TRIGGER "audit_events_immutable_truncate" BEFORE TRUNCATE ON "audit_events" FOR EACH STATEMENT EXECUTE FUNCTION "public"."workloom_reject_audit_mutation"();
