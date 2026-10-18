CREATE TABLE "generic_report_definitions" (
 "id" uuid PRIMARY KEY, "workspace_id" uuid NOT NULL, "project_id" uuid NOT NULL,
 "name" text NOT NULL, "revision" integer NOT NULL, "config" jsonb NOT NULL,
 "archived_at" timestamptz, "created_at" timestamptz NOT NULL, "updated_at" timestamptz NOT NULL,
 CONSTRAINT "generic_reports_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "projects"("workspace_id","id"),
 CONSTRAINT "generic_reports_scope_unique" UNIQUE ("workspace_id","project_id","id"),
 CONSTRAINT "generic_reports_revision_positive" CHECK ("revision">0),
 CONSTRAINT "generic_reports_name_length" CHECK (char_length(btrim("name")) BETWEEN 1 AND 160),
 CONSTRAINT "generic_reports_config_scope" CHECK ((jsonb_typeof("config")='object' AND "config"->>'projectId'="project_id"::text) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "generic_report_definition_versions" (
 "workspace_id" uuid NOT NULL,"project_id" uuid NOT NULL,"report_id" uuid NOT NULL,"revision" integer NOT NULL,
 "snapshot" jsonb NOT NULL,"created_at" timestamptz NOT NULL,
 PRIMARY KEY ("workspace_id","project_id","report_id","revision"),
 CONSTRAINT "generic_report_versions_definition_fk" FOREIGN KEY ("workspace_id","project_id","report_id") REFERENCES "generic_report_definitions"("workspace_id","project_id","id"),
 CONSTRAINT "generic_report_versions_revision_positive" CHECK ("revision">0),
 CONSTRAINT "generic_report_versions_snapshot_scope" CHECK ((jsonb_typeof("snapshot")='object' AND "snapshot"->>'id'="report_id"::text AND "snapshot"->>'workspaceId'="workspace_id"::text AND "snapshot"->>'projectId'="project_id"::text AND ("snapshot"->>'revision')::integer="revision") IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "generic_report_initial_snapshots" (
 "id" uuid PRIMARY KEY,"workspace_id" uuid NOT NULL,"project_id" uuid NOT NULL,"report_id" uuid NOT NULL,"definition_revision" integer NOT NULL,
 "header" jsonb NOT NULL,"rows" jsonb NOT NULL,"values" jsonb NOT NULL,"created_at" timestamptz NOT NULL,
 CONSTRAINT "generic_initial_version_fk" FOREIGN KEY ("workspace_id","project_id","report_id","definition_revision") REFERENCES "generic_report_definition_versions"("workspace_id","project_id","report_id","revision"),
 CONSTRAINT "generic_initial_header_scope" CHECK ((jsonb_typeof("header")='object' AND "header"->>'id'="id"::text AND "header"->>'workspaceId'="workspace_id"::text AND "header"->>'projectId'="project_id"::text AND "header"->>'reportId'="report_id"::text AND ("header"->>'definitionRevision')::integer="definition_revision") IS TRUE),
 CONSTRAINT "generic_initial_rows_shape" CHECK ((jsonb_typeof("rows")='array' AND jsonb_array_length("rows")<=5000 AND jsonb_array_length("rows")=("header"->>'taskCount')::integer AND jsonb_typeof("values")='array') IS TRUE)
);
--> statement-breakpoint
CREATE INDEX "generic_initial_report_idx" ON "generic_report_initial_snapshots"("workspace_id","report_id","created_at");
--> statement-breakpoint
CREATE TABLE "generic_report_column_settings" (
 "workspace_id" uuid NOT NULL,"project_id" uuid NOT NULL,"revision" integer NOT NULL,"measures" jsonb NOT NULL,
 PRIMARY KEY ("workspace_id","project_id"),
 CONSTRAINT "generic_report_columns_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "projects"("workspace_id","id"),
 CONSTRAINT "generic_report_columns_revision_positive" CHECK ("revision">0),
 CONSTRAINT "generic_report_columns_measures" CHECK (jsonb_typeof("measures")='array' AND jsonb_array_length("measures")<=12)
);
--> statement-breakpoint
CREATE TRIGGER "generic_report_versions_immutable_rows" BEFORE UPDATE OR DELETE ON "generic_report_definition_versions" FOR EACH ROW EXECUTE FUNCTION "workloom_reject_field_value_history_mutation"();
--> statement-breakpoint
CREATE TRIGGER "generic_report_versions_immutable_truncate" BEFORE TRUNCATE ON "generic_report_definition_versions" FOR EACH STATEMENT EXECUTE FUNCTION "workloom_reject_field_value_history_mutation"();
--> statement-breakpoint
CREATE TRIGGER "generic_initial_immutable_rows" BEFORE UPDATE OR DELETE ON "generic_report_initial_snapshots" FOR EACH ROW EXECUTE FUNCTION "workloom_reject_field_value_history_mutation"();
--> statement-breakpoint
CREATE TRIGGER "generic_initial_immutable_truncate" BEFORE TRUNCATE ON "generic_report_initial_snapshots" FOR EACH STATEMENT EXECUTE FUNCTION "workloom_reject_field_value_history_mutation"();
