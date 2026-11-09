CREATE TABLE "project_views" (
  "workspace_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "revision" integer NOT NULL CHECK ("revision" > 0),
  "views" jsonb NOT NULL CHECK (jsonb_typeof("views") = 'array'),
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "project_views_pkey" PRIMARY KEY ("workspace_id", "project_id"),
  CONSTRAINT "project_views_project_fk" FOREIGN KEY ("workspace_id", "project_id")
    REFERENCES "projects" ("workspace_id", "id")
);
