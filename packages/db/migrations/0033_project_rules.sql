-- Optional per-project rules (for example "a task can belong to only one project"). No row means every rule is off.
CREATE TABLE "project_rules" (
  "workspace_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "revision" integer NOT NULL,
  "config" jsonb NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "project_rules_pkey" PRIMARY KEY ("workspace_id", "project_id"),
  CONSTRAINT "project_rules_project_fk" FOREIGN KEY ("workspace_id", "project_id") REFERENCES "projects" ("workspace_id", "id"),
  CONSTRAINT "project_rules_revision_positive" CHECK ("revision" > 0),
  CONSTRAINT "project_rules_shape" CHECK (jsonb_typeof("config") = 'object')
);
