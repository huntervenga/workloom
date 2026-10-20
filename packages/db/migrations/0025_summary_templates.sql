CREATE TABLE "summary_templates" (
 "id" uuid PRIMARY KEY,"workspace_id" uuid NOT NULL,"project_id" uuid NOT NULL,"revision" integer NOT NULL,"snapshot" jsonb NOT NULL,
 CONSTRAINT "summary_template_scope_unique" UNIQUE("workspace_id","project_id","id"),
 FOREIGN KEY("workspace_id","project_id") REFERENCES "projects"("workspace_id","id"),
 CONSTRAINT "summary_template_revision" CHECK("revision">0),
 CONSTRAINT "summary_template_scope" CHECK((jsonb_typeof("snapshot")='object' AND "snapshot"->>'id'="id"::text AND "snapshot"->>'workspaceId'="workspace_id"::text AND "snapshot"->>'projectId'="project_id"::text AND ("snapshot"->>'revision')::integer="revision" AND jsonb_typeof("snapshot"->'content'->'widgets')='array' AND jsonb_array_length("snapshot"->'content'->'widgets')<=4 AND jsonb_typeof("snapshot"->'content'->'balanceChecks')='array' AND jsonb_array_length("snapshot"->'content'->'balanceChecks')<=50) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "summary_template_versions" (
 "workspace_id" uuid NOT NULL,"project_id" uuid NOT NULL,"template_id" uuid NOT NULL,"revision" integer NOT NULL,"snapshot" jsonb NOT NULL,"actor_user_id" uuid NOT NULL REFERENCES "users"("id"),"created_at" timestamptz NOT NULL,
 PRIMARY KEY("workspace_id","project_id","template_id","revision"),
 FOREIGN KEY("workspace_id","project_id","template_id") REFERENCES "summary_templates"("workspace_id","project_id","id"),
 CONSTRAINT "summary_template_version_scope" CHECK(("snapshot"->>'id'="template_id"::text AND "snapshot"->>'workspaceId'="workspace_id"::text AND "snapshot"->>'projectId'="project_id"::text AND ("snapshot"->>'revision')::integer="revision" AND "revision">0) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "summary_template_bindings" (
 "id" uuid PRIMARY KEY,"workspace_id" uuid NOT NULL,"project_id" uuid NOT NULL,"template_id" uuid NOT NULL,"revision" integer NOT NULL,"group_key" text NOT NULL,"detached" boolean NOT NULL,"snapshot" jsonb NOT NULL,
 CONSTRAINT "summary_binding_scope_unique" UNIQUE("workspace_id","project_id","id"),
 FOREIGN KEY("workspace_id","project_id","template_id") REFERENCES "summary_templates"("workspace_id","project_id","id"),
 CONSTRAINT "summary_binding_scope" CHECK(("snapshot"->>'id'="id"::text AND "snapshot"->>'workspaceId'="workspace_id"::text AND "snapshot"->>'projectId'="project_id"::text AND "snapshot"->>'templateId'="template_id"::text AND ("snapshot"->>'revision')::integer="revision" AND ("snapshot"->>'detached')::boolean="detached" AND "revision">0 AND "group_key"=("snapshot"->'group'->>'kind')||':'||coalesce("snapshot"->'group'->>'sectionId',"snapshot"->'group'->>'membershipId','null')) IS TRUE)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "summary_binding_active_group_unique" ON "summary_template_bindings"("workspace_id","project_id","group_key") WHERE NOT "detached";
--> statement-breakpoint
CREATE TABLE "summary_template_binding_versions" (
 "workspace_id" uuid NOT NULL,"project_id" uuid NOT NULL,"binding_id" uuid NOT NULL,"revision" integer NOT NULL,"snapshot" jsonb NOT NULL,"actor_user_id" uuid NOT NULL REFERENCES "users"("id"),"created_at" timestamptz NOT NULL,
 PRIMARY KEY("workspace_id","project_id","binding_id","revision"),
 FOREIGN KEY("workspace_id","project_id","binding_id") REFERENCES "summary_template_bindings"("workspace_id","project_id","id"),
 CONSTRAINT "summary_binding_version_scope" CHECK(("snapshot"->>'id'="binding_id"::text AND "snapshot"->>'workspaceId'="workspace_id"::text AND "snapshot"->>'projectId'="project_id"::text AND ("snapshot"->>'revision')::integer="revision" AND "revision">0) IS TRUE)
);
--> statement-breakpoint
CREATE TRIGGER "summary_template_versions_immutable_rows" BEFORE UPDATE OR DELETE ON "summary_template_versions" FOR EACH ROW EXECUTE FUNCTION "workloom_reject_field_value_history_mutation"();
--> statement-breakpoint
CREATE TRIGGER "summary_template_versions_immutable_truncate" BEFORE TRUNCATE ON "summary_template_versions" FOR EACH STATEMENT EXECUTE FUNCTION "workloom_reject_field_value_history_mutation"();
--> statement-breakpoint
CREATE TRIGGER "summary_binding_versions_immutable_rows" BEFORE UPDATE OR DELETE ON "summary_template_binding_versions" FOR EACH ROW EXECUTE FUNCTION "workloom_reject_field_value_history_mutation"();
--> statement-breakpoint
CREATE TRIGGER "summary_binding_versions_immutable_truncate" BEFORE TRUNCATE ON "summary_template_binding_versions" FOR EACH STATEMENT EXECUTE FUNCTION "workloom_reject_field_value_history_mutation"();
