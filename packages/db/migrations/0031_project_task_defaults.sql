-- Per-project starting values for new tasks (status, priority, estimate and ordinary field values).
CREATE TABLE "project_task_defaults" (
  "workspace_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "revision" integer NOT NULL,
  "config" jsonb NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "project_task_defaults_pkey" PRIMARY KEY ("workspace_id", "project_id"),
  CONSTRAINT "project_task_defaults_project_fk" FOREIGN KEY ("workspace_id", "project_id") REFERENCES "projects" ("workspace_id", "id"),
  CONSTRAINT "project_task_defaults_revision_positive" CHECK ("revision" > 0),
  CONSTRAINT "project_task_defaults_shape" CHECK (jsonb_typeof("config") = 'object' AND jsonb_typeof("config" -> 'fieldValues') = 'array' AND jsonb_array_length("config" -> 'fieldValues') <= 50)
);
