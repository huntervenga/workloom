-- A canonical task may change its home project through the explicit transfer command.
-- Import provenance stays exactly as recorded: a reference keeps the project and import it was created in, and is
-- tied to the task itself instead of to the task's current home project.
-- (A hosted database loaded without foreign keys has no such constraint: nothing to replace there.)
DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'external_import_references_task_fk' AND conrelid = 'external_import_references'::regclass) THEN
  ALTER TABLE "external_import_references" DROP CONSTRAINT "external_import_references_task_fk";
  ALTER TABLE "external_import_references" ADD CONSTRAINT "external_import_references_task_fk"
   FOREIGN KEY ("workspace_id", "task_id") REFERENCES "tasks" ("workspace_id", "id");
 END IF;
END $$;
--> statement-breakpoint
-- A transfer swaps which placement carries the task's own id (the home row must have id = task id), so the primary
-- key may be checked at the end of the statement. Nothing references this key.
ALTER TABLE "task_project_placements" DROP CONSTRAINT "task_project_placements_pkey";
--> statement-breakpoint
ALTER TABLE "task_project_placements" ADD CONSTRAINT "task_project_placements_pkey" PRIMARY KEY ("id") DEFERRABLE INITIALLY IMMEDIATE;
--> statement-breakpoint
-- Placement identity stays immutable except inside a transfer transaction (workloom.task_transfer = on, set locally
-- by the command), where placements of the moving task may change their home and swap the home row id. The command
-- verifies the home-row invariants itself before the transaction can commit.
CREATE OR REPLACE FUNCTION workloom_protect_placement_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE canonical tasks%ROWTYPE;
 moving boolean := coalesce(current_setting('workloom.task_transfer', true),'')='on';
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.project_id=OLD.home_project_id THEN RAISE EXCEPTION 'Accounting home placement cannot be deleted'; END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' AND (NEW.workspace_id,NEW.task_id,NEW.project_id,NEW.created_at)
  IS DISTINCT FROM (OLD.workspace_id,OLD.task_id,OLD.project_id,OLD.created_at) THEN
  RAISE EXCEPTION 'Placement identity is immutable';
 END IF;
 IF TG_OP='UPDATE' AND NOT moving AND (NEW.id,NEW.home_project_id) IS DISTINCT FROM (OLD.id,OLD.home_project_id) THEN
  RAISE EXCEPTION 'Placement identity is immutable';
 END IF;
 IF NEW.project_id=NEW.home_project_id AND NOT moving THEN
  SELECT * INTO canonical FROM tasks WHERE workspace_id=NEW.workspace_id AND id=NEW.task_id;
  IF NOT FOUND OR NEW.id<>canonical.id OR NEW.home_project_id<>canonical.project_id OR NEW.archived_at IS NOT NULL
   OR NEW.section_id IS DISTINCT FROM canonical.section_id OR NEW.position<>canonical.position THEN
   RAISE EXCEPTION 'Accounting home placement must mirror canonical task metadata';
  END IF;
 END IF;
 RETURN NEW;
END;
$$;
