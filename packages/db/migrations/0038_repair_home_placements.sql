-- A hosted database that was loaded without its triggers never created or updated the home placement of tasks created or
-- edited afterwards (for example the tasks of an Asana import), and a project's rows are read from placements.
-- 1. Give every task the home placement it should have had; 2. bring existing home placements back in line with their
-- task; 3. put the two triggers back (CREATE OR REPLACE: a database that has them keeps them unchanged).
INSERT INTO "task_project_placements" ("id", "workspace_id", "task_id", "home_project_id", "project_id", "section_id", "position", "revision", "created_at", "updated_at")
SELECT t."id", t."workspace_id", t."id", t."project_id", t."project_id", t."section_id", t."position", 1, t."created_at", t."updated_at"
FROM "tasks" t
WHERE NOT EXISTS (SELECT 1 FROM "task_project_placements" p WHERE p."workspace_id" = t."workspace_id" AND p."task_id" = t."id" AND p."project_id" = t."project_id")
  AND NOT EXISTS (SELECT 1 FROM "task_project_placements" q WHERE q."id" = t."id");
--> statement-breakpoint
UPDATE "task_project_placements" p
SET "section_id" = t."section_id", "position" = t."position", "revision" = p."revision" + 1, "updated_at" = t."updated_at"
FROM "tasks" t
WHERE p."workspace_id" = t."workspace_id" AND p."task_id" = t."id" AND p."project_id" = t."project_id" AND p."project_id" = p."home_project_id"
  AND (p."section_id" IS DISTINCT FROM t."section_id" OR p."position" <> t."position");
--> statement-breakpoint
CREATE OR REPLACE TRIGGER task_home_placement_sync AFTER INSERT OR UPDATE OF section_id, "position" ON "tasks"
 FOR EACH ROW EXECUTE FUNCTION workloom_sync_home_placement();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER task_placement_identity_guard BEFORE INSERT OR UPDATE OR DELETE ON "task_project_placements"
 FOR EACH ROW EXECUTE FUNCTION workloom_protect_placement_identity();
