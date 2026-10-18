-- PRIVATE CANDIDATE. Not executed or accepted. Additive: no task/history/receipt writes.
CREATE TABLE "task_project_placements" (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL, task_id uuid NOT NULL,
 home_project_id uuid NOT NULL, project_id uuid NOT NULL, section_id uuid,
 position integer NOT NULL, revision integer NOT NULL DEFAULT 1,
 archived_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT task_placements_task_home_fk FOREIGN KEY(workspace_id,home_project_id,task_id) REFERENCES tasks(workspace_id,project_id,id),
 CONSTRAINT task_placements_project_fk FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id),
 CONSTRAINT task_placements_section_fk FOREIGN KEY(workspace_id,project_id,section_id) REFERENCES sections(workspace_id,project_id,id),
 CONSTRAINT task_placements_workspace_task_project_unique UNIQUE(workspace_id,task_id,project_id),
 CONSTRAINT task_placements_revision_positive CHECK(revision>=1),
 CONSTRAINT task_placements_position_nonnegative CHECK(position>=0),
 CONSTRAINT task_placements_home_identity CHECK(project_id<>home_project_id OR (id=task_id AND archived_at IS NULL))
);
--> statement-breakpoint
CREATE INDEX task_placements_project_order_idx ON task_project_placements(workspace_id,project_id,position,id);
--> statement-breakpoint
-- Home IDs are deterministic and require no extension or random generator.
INSERT INTO task_project_placements(id,workspace_id,task_id,home_project_id,project_id,section_id,position,revision,created_at,updated_at)
 SELECT id,workspace_id,id,project_id,project_id,section_id,position,1,created_at,updated_at FROM tasks;
--> statement-breakpoint
-- Every existing task writer (imports, meeting composer, generic create/move) maintains the home row.
CREATE FUNCTION workloom_sync_home_placement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  INSERT INTO task_project_placements(id,workspace_id,task_id,home_project_id,project_id,section_id,position,revision,created_at,updated_at)
   VALUES(NEW.id,NEW.workspace_id,NEW.id,NEW.project_id,NEW.project_id,NEW.section_id,NEW.position,1,NEW.created_at,NEW.updated_at);
 ELSIF NEW.section_id IS DISTINCT FROM OLD.section_id OR NEW.position IS DISTINCT FROM OLD.position THEN
  UPDATE task_project_placements SET section_id=NEW.section_id,position=NEW.position,revision=revision+1,updated_at=NEW.updated_at
   WHERE workspace_id=NEW.workspace_id AND task_id=NEW.id AND project_id=NEW.project_id;
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER task_home_placement_sync AFTER INSERT OR UPDATE OF section_id,position ON tasks
 FOR EACH ROW EXECUTE FUNCTION workloom_sync_home_placement();
--> statement-breakpoint
-- Direct SQL cannot detach, retarget, delete or desynchronize a mandatory home placement.
CREATE FUNCTION workloom_protect_placement_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE canonical tasks%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.project_id=OLD.home_project_id THEN RAISE EXCEPTION 'Accounting home placement cannot be deleted'; END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' AND (NEW.id,NEW.workspace_id,NEW.task_id,NEW.home_project_id,NEW.project_id,NEW.created_at)
  IS DISTINCT FROM (OLD.id,OLD.workspace_id,OLD.task_id,OLD.home_project_id,OLD.project_id,OLD.created_at) THEN
  RAISE EXCEPTION 'Placement identity is immutable';
 END IF;
 IF NEW.project_id=NEW.home_project_id THEN
  SELECT * INTO canonical FROM tasks WHERE workspace_id=NEW.workspace_id AND id=NEW.task_id;
  IF NOT FOUND OR NEW.id<>canonical.id OR NEW.home_project_id<>canonical.project_id OR NEW.archived_at IS NOT NULL
   OR NEW.section_id IS DISTINCT FROM canonical.section_id OR NEW.position<>canonical.position THEN
   RAISE EXCEPTION 'Accounting home placement must mirror canonical task metadata';
  END IF;
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER task_placement_identity_guard BEFORE INSERT OR UPDATE OR DELETE ON task_project_placements
 FOR EACH ROW EXECUTE FUNCTION workloom_protect_placement_identity();
