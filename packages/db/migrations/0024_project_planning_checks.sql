CREATE TABLE "project_check_settings" (
 "workspace_id" uuid NOT NULL,"project_id" uuid NOT NULL,"revision" integer NOT NULL,"config" jsonb NOT NULL,"updated_at" timestamptz NOT NULL,
 PRIMARY KEY("workspace_id","project_id"),
 CONSTRAINT "project_checks_project_fk" FOREIGN KEY("workspace_id","project_id") REFERENCES "projects"("workspace_id","id"),
 CONSTRAINT "project_checks_revision_positive" CHECK("revision">0),
 CONSTRAINT "project_checks_config_shape" CHECK((jsonb_typeof("config")='object' AND jsonb_typeof("config"->'enabled')='boolean' AND jsonb_typeof("config"->'rules')='array' AND jsonb_array_length("config"->'rules')<=50) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "project_check_settings_versions" (
 "workspace_id" uuid NOT NULL,"project_id" uuid NOT NULL,"revision" integer NOT NULL,"snapshot" jsonb NOT NULL,"actor_user_id" uuid NOT NULL REFERENCES "users"("id"),"created_at" timestamptz NOT NULL,
 PRIMARY KEY("workspace_id","project_id","revision"),
 CONSTRAINT "project_check_versions_settings_fk" FOREIGN KEY("workspace_id","project_id") REFERENCES "project_check_settings"("workspace_id","project_id"),
 CONSTRAINT "project_check_versions_scope" CHECK((jsonb_typeof("snapshot")='object' AND "snapshot"->>'workspaceId'="workspace_id"::text AND "snapshot"->>'projectId'="project_id"::text AND ("snapshot"->>'revision')::integer="revision" AND "revision">0) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "project_check_checkpoints" (
 "id" uuid PRIMARY KEY,"workspace_id" uuid NOT NULL,"project_id" uuid NOT NULL,"settings_revision" integer NOT NULL,"snapshot" jsonb NOT NULL,"created_at" timestamptz NOT NULL,
 CONSTRAINT "project_check_checkpoint_version_fk" FOREIGN KEY("workspace_id","project_id","settings_revision") REFERENCES "project_check_settings_versions"("workspace_id","project_id","revision"),
 CONSTRAINT "project_check_checkpoint_scope" CHECK((jsonb_typeof("snapshot")='object' AND "snapshot"->>'id'="id"::text AND "snapshot"->>'workspaceId'="workspace_id"::text AND "snapshot"->>'projectId'="project_id"::text AND ("snapshot"->>'settingsRevision')::integer="settings_revision" AND jsonb_typeof("snapshot"->'assessment')='object' AND NOT (("snapshot"->'assessment') ? 'taskFlags')) IS TRUE)
);
--> statement-breakpoint
CREATE INDEX "project_check_checkpoints_scope_idx" ON "project_check_checkpoints"("workspace_id","project_id","created_at");
--> statement-breakpoint
CREATE TRIGGER "project_check_versions_immutable_rows" BEFORE UPDATE OR DELETE ON "project_check_settings_versions" FOR EACH ROW EXECUTE FUNCTION "workloom_reject_field_value_history_mutation"();
--> statement-breakpoint
CREATE TRIGGER "project_check_versions_immutable_truncate" BEFORE TRUNCATE ON "project_check_settings_versions" FOR EACH STATEMENT EXECUTE FUNCTION "workloom_reject_field_value_history_mutation"();
--> statement-breakpoint
CREATE TRIGGER "project_check_checkpoints_immutable_rows" BEFORE UPDATE OR DELETE ON "project_check_checkpoints" FOR EACH ROW EXECUTE FUNCTION "workloom_reject_field_value_history_mutation"();
--> statement-breakpoint
CREATE TRIGGER "project_check_checkpoints_immutable_truncate" BEFORE TRUNCATE ON "project_check_checkpoints" FOR EACH STATEMENT EXECUTE FUNCTION "workloom_reject_field_value_history_mutation"();
