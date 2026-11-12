-- Time is a property of every task: each project keeps it in two duration fields with the role "estimate" or "fact".
-- 1. the role column and its rules; 2. existing duration fields get their role by name; 3. a project without one gets
-- the field, with its immutable first version and a visible column, the same rows a created field has.
ALTER TABLE "task_field_definitions" ADD COLUMN "time_role" text;
--> statement-breakpoint
ALTER TABLE "task_field_definitions" ADD CONSTRAINT "task_field_definitions_time_role_check"
  CHECK ("time_role" IS NULL OR ("time_role" IN ('estimate', 'fact') AND "type" = 'duration'));
--> statement-breakpoint
CREATE UNIQUE INDEX "task_field_definitions_time_role_unique_idx"
  ON "task_field_definitions" ("workspace_id", "project_id", "time_role")
  WHERE "time_role" IS NOT NULL AND "archived_at" IS NULL;
--> statement-breakpoint
UPDATE "task_field_definitions" AS f SET "time_role" = c."role"
FROM (
  SELECT DISTINCT ON (d."workspace_id", d."project_id", r."role") d."id", r."role"
  FROM "task_field_definitions" AS d
  JOIN (VALUES ('estimate', 'hours est', 1), ('estimate', 'estimation', 2), ('estimate', 'estimate', 3), ('estimate', 'plan', 4),
               ('fact', 'hours fact', 1), ('fact', 'fact', 2), ('fact', 'actual', 3)) AS r("role", "name", "rank")
    ON lower(btrim(d."name")) = r."name"
  WHERE d."type" = 'duration' AND d."archived_at" IS NULL
  ORDER BY d."workspace_id", d."project_id", r."role", r."rank"
) AS c
WHERE f."id" = c."id";
--> statement-breakpoint
WITH "missing" AS (
  SELECT p."workspace_id", p."id" AS "project_id", r."role", r."rank",
    CASE
      WHEN NOT EXISTS (SELECT 1 FROM "task_field_definitions" x WHERE x."workspace_id" = p."workspace_id" AND x."project_id" = p."id" AND lower(x."name") = lower(r."first")) THEN r."first"
      WHEN NOT EXISTS (SELECT 1 FROM "task_field_definitions" x WHERE x."workspace_id" = p."workspace_id" AND x."project_id" = p."id" AND lower(x."name") = lower(r."second")) THEN r."second"
      ELSE r."third"
    END AS "name",
    gen_random_uuid() AS "field_id", gen_random_uuid() AS "version_id", now() AS "at",
    COALESCE((SELECT max(pc."position") FROM "project_columns" pc WHERE pc."workspace_id" = p."workspace_id" AND pc."project_id" = p."id"), -1) AS "last_position"
  FROM "projects" AS p
  CROSS JOIN (VALUES ('estimate', 1, 'Hours Est', 'Estimate', 'Hours Est (time)'), ('fact', 2, 'Hours Fact', 'Fact', 'Hours Fact (time)')) AS r("role", "rank", "first", "second", "third")
  WHERE NOT EXISTS (
    SELECT 1 FROM "task_field_definitions" d
    WHERE d."workspace_id" = p."workspace_id" AND d."project_id" = p."id" AND d."time_role" = r."role" AND d."archived_at" IS NULL
  )
),
"numbered" AS (
  SELECT m.*, m."last_position" + row_number() OVER (PARTITION BY m."workspace_id", m."project_id" ORDER BY m."rank") AS "position"
  FROM "missing" m
),
"fields" AS (
  INSERT INTO "task_field_definitions" ("id", "workspace_id", "project_id", "name", "type", "revision", "definition_version_id", "history_enabled", "locked", "time_role", "archived_at", "created_at", "updated_at")
  SELECT n."field_id", n."workspace_id", n."project_id", n."name", 'duration', 1, n."version_id", true, false, n."role", NULL, n."at", n."at" FROM "numbered" n
  RETURNING "id"
),
"versions" AS (
  INSERT INTO "task_field_definition_versions" ("id", "workspace_id", "project_id", "field_id", "revision", "snapshot", "created_at")
  SELECT n."version_id", n."workspace_id", n."project_id", n."field_id", 1,
    jsonb_build_object(
      'id', n."field_id", 'workspaceId', n."workspace_id", 'projectId', n."project_id", 'name', n."name", 'type', 'duration',
      'revision', 1, 'definitionVersionId', n."version_id", 'historyEnabled', true, 'locked', false, 'archivedAt', NULL,
      'options', '[]'::jsonb, 'timeRole', n."role",
      'createdAt', to_char(n."at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'updatedAt', to_char(n."at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ),
    n."at"
  FROM "numbered" n
  RETURNING "id"
),
"settings" AS (
  INSERT INTO "project_column_settings" ("workspace_id", "project_id", "revision")
  SELECT DISTINCT n."workspace_id", n."project_id", 1 FROM "numbered" n
  ON CONFLICT ("workspace_id", "project_id") DO UPDATE SET "revision" = "project_column_settings"."revision" + 1
  RETURNING "project_id"
)
INSERT INTO "project_columns" ("workspace_id", "project_id", "field_id", "visible", "width", "position")
SELECT n."workspace_id", n."project_id", n."field_id", true, 160, n."position" FROM "numbered" n;
