CREATE TABLE shared_activities (
 id uuid PRIMARY KEY,workspace_id uuid NOT NULL,project_id uuid NOT NULL,task_id uuid NOT NULL,revision integer NOT NULL,document jsonb NOT NULL,
 CONSTRAINT shared_activity_workspace_unique UNIQUE(workspace_id,id),CONSTRAINT shared_activity_task_unique UNIQUE(workspace_id,task_id),CONSTRAINT shared_activity_task_identity UNIQUE(workspace_id,id,task_id),
 CONSTRAINT shared_activity_task_fk FOREIGN KEY(workspace_id,project_id,task_id) REFERENCES tasks(workspace_id,project_id,id),
 CONSTRAINT shared_activity_identity CHECK((document->>'id'=id::text AND document->>'workspaceId'=workspace_id::text AND document->>'projectId'=project_id::text AND document->>'taskId'=task_id::text AND (document->>'revision')::integer=revision AND revision>0) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE shared_activity_versions (
 workspace_id uuid NOT NULL,activity_id uuid NOT NULL,revision integer NOT NULL,document jsonb NOT NULL,actor_user_id uuid NOT NULL REFERENCES users(id),change_seq bigint NOT NULL,recorded_at timestamptz NOT NULL,
 PRIMARY KEY(workspace_id,activity_id,revision),CONSTRAINT shared_activity_version_fk FOREIGN KEY(workspace_id,activity_id) REFERENCES shared_activities(workspace_id,id),
 CONSTRAINT shared_activity_version_identity CHECK((document->>'id'=activity_id::text AND document->>'workspaceId'=workspace_id::text AND (document->>'revision')::integer=revision AND revision>0 AND change_seq>0) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE shared_activity_contributions (
 id uuid PRIMARY KEY,workspace_id uuid NOT NULL,activity_id uuid NOT NULL,task_id uuid NOT NULL,membership_id uuid NOT NULL,revision integer NOT NULL,document jsonb NOT NULL,
 CONSTRAINT shared_contribution_workspace_unique UNIQUE(workspace_id,id),CONSTRAINT shared_contribution_member_unique UNIQUE(workspace_id,activity_id,membership_id),CONSTRAINT shared_contribution_activity_identity UNIQUE(workspace_id,activity_id,id),
 CONSTRAINT shared_contribution_activity_fk FOREIGN KEY(workspace_id,activity_id,task_id) REFERENCES shared_activities(workspace_id,id,task_id),
 CONSTRAINT shared_contribution_member_fk FOREIGN KEY(workspace_id,membership_id) REFERENCES memberships(workspace_id,id),
 CONSTRAINT shared_contribution_identity CHECK((document->>'id'=id::text AND document->>'workspaceId'=workspace_id::text AND document->>'activityId'=activity_id::text AND document->>'taskId'=task_id::text AND document->>'membershipId'=membership_id::text AND (document->>'revision')::integer=revision AND revision>0 AND document->>'attendance' IN ('unconfirmed','present','partial','absent') AND document->>'postingState' IN ('unconfirmed','active','void')) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE shared_activity_contribution_versions (
 id uuid PRIMARY KEY,workspace_id uuid NOT NULL,activity_id uuid NOT NULL,contribution_id uuid NOT NULL,revision integer NOT NULL,document jsonb NOT NULL,actor_user_id uuid NOT NULL REFERENCES users(id),change_seq bigint NOT NULL,recorded_at timestamptz NOT NULL,
 CONSTRAINT shared_contribution_version_unique UNIQUE(workspace_id,contribution_id,revision),CONSTRAINT shared_contribution_version_fk FOREIGN KEY(workspace_id,activity_id,contribution_id) REFERENCES shared_activity_contributions(workspace_id,activity_id,id),CONSTRAINT shared_contribution_version_activity_fk FOREIGN KEY(workspace_id,activity_id) REFERENCES shared_activities(workspace_id,id),
 CONSTRAINT shared_contribution_version_identity CHECK((document->>'id'=id::text AND document->'contribution'->>'id'=contribution_id::text AND document->'contribution'->>'workspaceId'=workspace_id::text AND document->'contribution'->>'activityId'=activity_id::text AND (document->'contribution'->>'revision')::integer=revision AND revision>0 AND change_seq>0) IS TRUE)
);
--> statement-breakpoint
CREATE FUNCTION workloom_guard_shared_activity_head() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Shared source history cannot be deleted'; END IF;
 IF TG_TABLE_NAME='shared_activity_contributions' THEN
  IF NOT EXISTS(SELECT 1 FROM shared_activity_versions WHERE workspace_id=NEW.workspace_id AND activity_id=NEW.activity_id AND revision=(NEW.document->>'originalActivityRevision')::integer) THEN RAISE EXCEPTION 'Original participation requires its captured activity version'; END IF;
  IF NEW.document->>'confirmedActivityRevision' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM shared_activity_versions WHERE workspace_id=NEW.workspace_id AND activity_id=NEW.activity_id AND revision=(NEW.document->>'confirmedActivityRevision')::integer) THEN RAISE EXCEPTION 'Attendance requires its confirmed activity version'; END IF;
 END IF;
 IF TG_OP='INSERT' THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='shared_activities' THEN
  IF (NEW.id,NEW.workspace_id,NEW.project_id,NEW.task_id) IS DISTINCT FROM (OLD.id,OLD.workspace_id,OLD.project_id,OLD.task_id) OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'Shared activity identity/revision is immutable'; END IF;
 ELSE
  IF (NEW.id,NEW.workspace_id,NEW.activity_id,NEW.task_id,NEW.membership_id) IS DISTINCT FROM (OLD.id,OLD.workspace_id,OLD.activity_id,OLD.task_id,OLD.membership_id) OR NEW.revision<>OLD.revision+1 OR NEW.document->'originalPlannedMinutes' IS DISTINCT FROM OLD.document->'originalPlannedMinutes' OR NEW.document->'originalActivityRevision' IS DISTINCT FROM OLD.document->'originalActivityRevision' THEN RAISE EXCEPTION 'Shared contribution identity/original plan is immutable'; END IF;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER shared_activity_head_guard BEFORE UPDATE OR DELETE ON shared_activities FOR EACH ROW EXECUTE FUNCTION workloom_guard_shared_activity_head();
--> statement-breakpoint
CREATE TRIGGER shared_contribution_head_guard BEFORE INSERT OR UPDATE OR DELETE ON shared_activity_contributions FOR EACH ROW EXECUTE FUNCTION workloom_guard_shared_activity_head();
--> statement-breakpoint
CREATE TRIGGER shared_activity_head_truncate BEFORE TRUNCATE ON shared_activities FOR EACH STATEMENT EXECUTE FUNCTION workloom_reject_field_value_history_mutation();
--> statement-breakpoint
CREATE TRIGGER shared_contribution_head_truncate BEFORE TRUNCATE ON shared_activity_contributions FOR EACH STATEMENT EXECUTE FUNCTION workloom_reject_field_value_history_mutation();
--> statement-breakpoint
CREATE TRIGGER shared_activity_versions_immutable BEFORE UPDATE OR DELETE ON shared_activity_versions FOR EACH ROW EXECUTE FUNCTION workloom_reject_field_value_history_mutation();
--> statement-breakpoint
CREATE TRIGGER shared_activity_versions_no_truncate BEFORE TRUNCATE ON shared_activity_versions FOR EACH STATEMENT EXECUTE FUNCTION workloom_reject_field_value_history_mutation();
--> statement-breakpoint
CREATE TRIGGER shared_contribution_versions_immutable BEFORE UPDATE OR DELETE ON shared_activity_contribution_versions FOR EACH ROW EXECUTE FUNCTION workloom_reject_field_value_history_mutation();
--> statement-breakpoint
CREATE TRIGGER shared_contribution_versions_no_truncate BEFORE TRUNCATE ON shared_activity_contribution_versions FOR EACH STATEMENT EXECUTE FUNCTION workloom_reject_field_value_history_mutation();

--> statement-breakpoint
CREATE FUNCTION workloom_guard_shared_source_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE head jsonb;
BEGIN
 IF TG_TABLE_NAME='shared_activity_versions' THEN
  SELECT document INTO head FROM shared_activities WHERE workspace_id=NEW.workspace_id AND id=NEW.activity_id AND revision=NEW.revision;
  IF head IS NULL OR NEW.document IS DISTINCT FROM head THEN RAISE EXCEPTION 'Shared activity version must match its current source'; END IF;
 ELSE
  SELECT document INTO head FROM shared_activity_contributions WHERE workspace_id=NEW.workspace_id AND activity_id=NEW.activity_id AND id=NEW.contribution_id AND revision=NEW.revision;
  IF head IS NULL OR NEW.document->'contribution' IS DISTINCT FROM head OR NEW.document->>'actorUserId' IS DISTINCT FROM NEW.actor_user_id::text OR (NEW.document->>'changeSeq')::bigint IS DISTINCT FROM NEW.change_seq OR (NEW.document->>'recordedAt')::timestamptz IS DISTINCT FROM NEW.recorded_at THEN RAISE EXCEPTION 'Shared contribution version must match its source and attribution'; END IF;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER shared_activity_version_source_guard BEFORE INSERT ON shared_activity_versions FOR EACH ROW EXECUTE FUNCTION workloom_guard_shared_source_version();
--> statement-breakpoint
CREATE TRIGGER shared_contribution_version_source_guard BEFORE INSERT ON shared_activity_contribution_versions FOR EACH ROW EXECUTE FUNCTION workloom_guard_shared_source_version();
