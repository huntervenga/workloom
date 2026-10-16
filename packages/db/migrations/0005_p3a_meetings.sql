CREATE TABLE "meeting_attendance_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"attendance_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"document" jsonb NOT NULL,
	CONSTRAINT "meeting_attendance_revisions_source_unique" UNIQUE("workspace_id","attendance_id","revision"),
	CONSTRAINT "meeting_attendance_revisions_document_identity" CHECK ((document->>'id'=id::text and document->>'attendanceId'=attendance_id::text and (document->>'revision')::integer=revision and revision>=1) is true)
);
--> statement-breakpoint
CREATE TABLE "meeting_attendances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"meeting_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"document" jsonb NOT NULL,
	CONSTRAINT "meeting_attendances_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "meeting_attendances_member_unique" UNIQUE("workspace_id","meeting_id","membership_id"),
	CONSTRAINT "meeting_attendances_source_unique" UNIQUE("workspace_id","meeting_id","task_id","membership_id","id"),
	CONSTRAINT "meeting_attendances_document_identity" CHECK ((document ?& array['id','workspaceId','meetingId','taskId','membershipId','revision','rosterActive','status','postingState'] and document->>'id'=id::text and document->>'workspaceId'=workspace_id::text and document->>'meetingId'=meeting_id::text and document->>'taskId'=task_id::text and document->>'membershipId'=membership_id::text and (document->>'revision')::integer=revision and revision>=1 and jsonb_typeof(document->'rosterActive')='boolean' and document->>'status' in ('unknown','present','partial','absent') and document->>'postingState' in ('unconfirmed','active','void')) is true)
);
--> statement-breakpoint
CREATE TABLE "meeting_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"meeting_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"document" jsonb NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"change_seq" bigint NOT NULL,
	CONSTRAINT "meeting_revisions_source_unique" UNIQUE("workspace_id","meeting_id","revision"),
	CONSTRAINT "meeting_revisions_document_identity" CHECK ((document->>'id'=meeting_id::text and document->>'workspaceId'=workspace_id::text and (document->>'revision')::integer=revision and revision>=1 and change_seq>=1) is true)
);
--> statement-breakpoint
CREATE TABLE "meeting_schedule_locks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"meeting_id" uuid NOT NULL,
	"baseline_id" uuid NOT NULL,
	CONSTRAINT "meeting_schedule_locks_baseline_unique" UNIQUE("workspace_id","meeting_id","baseline_id")
);
--> statement-breakpoint
CREATE TABLE "meetings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"work_package_id" uuid NOT NULL,
	"planned_period_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"document" jsonb NOT NULL,
	CONSTRAINT "meetings_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "meetings_project_id_unique" UNIQUE("workspace_id","project_id","id"),
	CONSTRAINT "meetings_task_unique" UNIQUE("workspace_id","task_id"),
	CONSTRAINT "meetings_package_unique" UNIQUE("workspace_id","work_package_id"),
	CONSTRAINT "meetings_source_unique" UNIQUE("workspace_id","id","task_id","planned_period_id"),
	CONSTRAINT "meetings_document_identity" CHECK ((document ?& array['id','workspaceId','projectId','taskId','workPackageId','plannedPeriodId','revision'] and document->>'id'=id::text and document->>'workspaceId'=workspace_id::text and document->>'projectId'=project_id::text and document->>'taskId'=task_id::text and document->>'workPackageId'=work_package_id::text and document->>'plannedPeriodId'=planned_period_id::text and (document->>'revision')::integer=revision and revision>=1) is true)
);
--> statement-breakpoint
ALTER TABLE "work_logs" DROP CONSTRAINT "work_logs_manual_source_unique";--> statement-breakpoint
ALTER TABLE "work_logs" DROP CONSTRAINT "work_logs_source_identity";--> statement-breakpoint
ALTER TABLE "work_log_revisions" ADD COLUMN "meeting_id" uuid;--> statement-breakpoint
ALTER TABLE "work_log_revisions" ADD COLUMN "attendance_id" uuid;--> statement-breakpoint
ALTER TABLE "work_log_revisions" ADD COLUMN "confirmed_meeting_revision" integer;--> statement-breakpoint
ALTER TABLE "work_log_revisions" ADD COLUMN "attribution" jsonb;--> statement-breakpoint
ALTER TABLE "work_logs" ADD COLUMN "meeting_id" uuid;--> statement-breakpoint
ALTER TABLE "work_logs" ADD COLUMN "attendance_id" uuid;--> statement-breakpoint
ALTER TABLE "meeting_attendance_revisions" ADD CONSTRAINT "meeting_attendance_revisions_attendance_fk" FOREIGN KEY ("workspace_id","attendance_id") REFERENCES "public"."meeting_attendances"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_attendances" ADD CONSTRAINT "meeting_attendances_meeting_fk" FOREIGN KEY ("workspace_id","project_id","meeting_id") REFERENCES "public"."meetings"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_attendances" ADD CONSTRAINT "meeting_attendances_task_fk" FOREIGN KEY ("workspace_id","project_id","task_id") REFERENCES "public"."tasks"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_attendances" ADD CONSTRAINT "meeting_attendances_member_fk" FOREIGN KEY ("workspace_id","membership_id") REFERENCES "public"."memberships"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_revisions" ADD CONSTRAINT "meeting_revisions_meeting_fk" FOREIGN KEY ("workspace_id","meeting_id") REFERENCES "public"."meetings"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_revisions" ADD CONSTRAINT "meeting_revisions_actor_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_schedule_locks" ADD CONSTRAINT "meeting_schedule_locks_meeting_fk" FOREIGN KEY ("workspace_id","meeting_id") REFERENCES "public"."meetings"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_schedule_locks" ADD CONSTRAINT "meeting_schedule_locks_baseline_fk" FOREIGN KEY ("workspace_id","baseline_id") REFERENCES "public"."plan_baselines"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_task_fk" FOREIGN KEY ("workspace_id","project_id","task_id") REFERENCES "public"."tasks"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_package_fk" FOREIGN KEY ("workspace_id","project_id","work_package_id") REFERENCES "public"."work_packages"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_period_fk" FOREIGN KEY ("workspace_id","project_id","planned_period_id") REFERENCES "public"."planning_periods"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_log_revisions" ADD CONSTRAINT "work_log_revisions_meeting_version_fk" FOREIGN KEY ("workspace_id","meeting_id","confirmed_meeting_revision") REFERENCES "public"."meeting_revisions"("workspace_id","meeting_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_logs" ADD CONSTRAINT "work_logs_meeting_fk" FOREIGN KEY ("workspace_id","meeting_id","task_id","period_id") REFERENCES "public"."meetings"("workspace_id","id","task_id","planned_period_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_logs" ADD CONSTRAINT "work_logs_attendance_fk" FOREIGN KEY ("workspace_id","meeting_id","task_id","membership_id","attendance_id") REFERENCES "public"."meeting_attendances"("workspace_id","meeting_id","task_id","membership_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "work_logs_manual_source_unique" ON "work_logs" USING btree ("workspace_id","task_id","membership_id","period_id") WHERE source_kind = 'manual_period';--> statement-breakpoint
ALTER TABLE "work_log_revisions" ADD CONSTRAINT "work_log_revisions_occurrence_shape" CHECK (((meeting_id is null and attendance_id is null and confirmed_meeting_revision is null and attribution is null) or (meeting_id is not null and attendance_id is not null and confirmed_meeting_revision>=1 and attribution ?& array['basis','plannedStartAt','actualStartAt'] and jsonb_typeof(attribution->'plannedStartAt')='string' and ((attribution->>'basis'='actual_meeting' and jsonb_typeof(attribution->'actualStartAt')='string') or (attribution->>'basis'='planned_absence' and attribution->'actualStartAt'='null'::jsonb and minutes=0)))) is true);--> statement-breakpoint
ALTER TABLE "work_logs" ADD CONSTRAINT "work_logs_source_identity" CHECK (((source_kind = 'manual_period' and meeting_id is null and attendance_id is null and source_key = task_id::text || ':' || membership_id::text || ':' || period_id::text) or (source_kind='meeting_attendance' and meeting_id is not null and attendance_id is not null and source_key=attendance_id::text)) is true);
--> statement-breakpoint
-- History, heads and occurrence attribution remain immutable/scoped across all adapters.
CREATE FUNCTION public.workloom_check_meeting_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actual_package uuid;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF (NEW.id,NEW.workspace_id,NEW.project_id,NEW.task_id,NEW.work_package_id,NEW.planned_period_id) IS DISTINCT FROM (OLD.id,OLD.workspace_id,OLD.project_id,OLD.task_id,OLD.work_package_id,OLD.planned_period_id) OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'Meeting identity/revision is immutable' USING ERRCODE='check_violation'; END IF;
 ELSE
  IF NEW.revision<>1 THEN RAISE EXCEPTION 'Meeting starts at revision one' USING ERRCODE='check_violation'; END IF;
 END IF;
 SELECT work_package_id INTO actual_package FROM public.tasks WHERE workspace_id=NEW.workspace_id AND project_id=NEW.project_id AND id=NEW.task_id;
 IF actual_package IS DISTINCT FROM NEW.work_package_id THEN RAISE EXCEPTION 'Meeting package must match task' USING ERRCODE='check_violation'; END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER meetings_identity_guard BEFORE INSERT OR UPDATE ON public.meetings FOR EACH ROW EXECUTE FUNCTION public.workloom_check_meeting_identity();
--> statement-breakpoint
CREATE FUNCTION public.workloom_check_attendance_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actual_task uuid;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF (NEW.id,NEW.workspace_id,NEW.project_id,NEW.meeting_id,NEW.task_id,NEW.membership_id) IS DISTINCT FROM (OLD.id,OLD.workspace_id,OLD.project_id,OLD.meeting_id,OLD.task_id,OLD.membership_id) OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'Attendance identity/revision is immutable' USING ERRCODE='check_violation'; END IF;
 ELSE
  IF NEW.revision<>1 THEN RAISE EXCEPTION 'Attendance starts at revision one' USING ERRCODE='check_violation'; END IF;
 END IF;
 SELECT task_id INTO actual_task FROM public.meetings WHERE workspace_id=NEW.workspace_id AND project_id=NEW.project_id AND id=NEW.meeting_id;
 IF actual_task IS DISTINCT FROM NEW.task_id THEN RAISE EXCEPTION 'Attendance must match meeting task' USING ERRCODE='check_violation'; END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER meeting_attendances_identity_guard BEFORE INSERT OR UPDATE ON public.meeting_attendances FOR EACH ROW EXECUTE FUNCTION public.workloom_check_attendance_identity();
--> statement-breakpoint
ALTER TABLE public.meetings ADD CONSTRAINT meetings_revision_head_fk FOREIGN KEY(workspace_id,id,revision) REFERENCES public.meeting_revisions(workspace_id,meeting_id,revision) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE public.meeting_attendances ADD CONSTRAINT meeting_attendances_revision_head_fk FOREIGN KEY(workspace_id,id,revision) REFERENCES public.meeting_attendance_revisions(workspace_id,attendance_id,revision) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
CREATE FUNCTION public.workloom_check_meeting_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE head jsonb;
BEGIN
 SELECT document INTO head FROM public.meetings WHERE workspace_id=NEW.workspace_id AND id=NEW.meeting_id AND revision=NEW.revision;
 IF NOT FOUND OR head IS DISTINCT FROM NEW.document THEN RAISE EXCEPTION 'Meeting revision must match current scoped head' USING ERRCODE='check_violation'; END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER meeting_revisions_head_guard BEFORE INSERT ON public.meeting_revisions FOR EACH ROW EXECUTE FUNCTION public.workloom_check_meeting_revision();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.workloom_check_manual_work_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actual_package uuid;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF (NEW.id,NEW.workspace_id,NEW.project_id,NEW.task_id,NEW.work_package_id,NEW.membership_id,NEW.period_id,NEW.source_kind,NEW.source_key,NEW.meeting_id,NEW.attendance_id) IS DISTINCT FROM (OLD.id,OLD.workspace_id,OLD.project_id,OLD.task_id,OLD.work_package_id,OLD.membership_id,OLD.period_id,OLD.source_kind,OLD.source_key,OLD.meeting_id,OLD.attendance_id) THEN RAISE EXCEPTION 'Work source identity is immutable' USING ERRCODE='check_violation'; END IF;
  IF NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'Work revision must advance once' USING ERRCODE='check_violation'; END IF;
 ELSE
  IF NEW.revision<>1 THEN RAISE EXCEPTION 'New work source starts at revision one' USING ERRCODE='check_violation'; END IF;
  SELECT work_package_id INTO actual_package FROM public.tasks WHERE workspace_id=NEW.workspace_id AND project_id=NEW.project_id AND id=NEW.task_id;
  IF actual_package IS DISTINCT FROM NEW.work_package_id THEN RAISE EXCEPTION 'Work package must match task' USING ERRCODE='check_violation'; END IF;
  IF NEW.source_kind='manual_period' AND EXISTS(SELECT 1 FROM public.meetings WHERE workspace_id=NEW.workspace_id AND task_id=NEW.task_id) THEN RAISE EXCEPTION 'Meeting time uses attendance source' USING ERRCODE='check_violation'; END IF;
 END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE FUNCTION public.workloom_check_occurrence_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source public.work_logs%ROWTYPE; confirmed jsonb;
BEGIN
 SELECT * INTO source FROM public.work_logs WHERE workspace_id=NEW.workspace_id AND id=NEW.work_log_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Missing scoped work source' USING ERRCODE='check_violation'; END IF;
 IF source.source_kind='manual_period' THEN
  IF NEW.meeting_id IS NOT NULL OR NEW.attendance_id IS NOT NULL OR NEW.confirmed_meeting_revision IS NOT NULL OR NEW.attribution IS NOT NULL THEN RAISE EXCEPTION 'Manual work has no occurrence attribution' USING ERRCODE='check_violation'; END IF;
 ELSE
  IF (NEW.meeting_id,NEW.attendance_id) IS DISTINCT FROM (source.meeting_id,source.attendance_id) THEN RAISE EXCEPTION 'Occurrence revision identity mismatches source' USING ERRCODE='check_violation'; END IF;
  SELECT document INTO confirmed FROM public.meeting_revisions WHERE workspace_id=NEW.workspace_id AND meeting_id=NEW.meeting_id AND revision=NEW.confirmed_meeting_revision;
  IF NOT FOUND OR (NEW.attribution->>'plannedStartAt') IS DISTINCT FROM (confirmed->>'plannedStartAt') THEN RAISE EXCEPTION 'Occurrence must reference confirmed immutable schedule' USING ERRCODE='check_violation'; END IF;
  IF NEW.attribution->>'basis'='actual_meeting' THEN
   IF confirmed->>'actualStartAt' IS NULL OR confirmed->>'actualDurationMinutes' IS NULL OR (NEW.attribution->>'actualStartAt') IS DISTINCT FROM (confirmed->>'actualStartAt') OR NEW.minutes>(confirmed->>'actualDurationMinutes')::integer THEN RAISE EXCEPTION 'Occurrence attribution must match confirmed actual details' USING ERRCODE='check_violation'; END IF;
  ELSIF NEW.attribution->>'basis'='planned_absence' THEN
   IF NEW.minutes<>0 THEN RAISE EXCEPTION 'Planned absence is zero' USING ERRCODE='check_violation'; END IF;
  ELSE RAISE EXCEPTION 'Unknown occurrence attribution basis' USING ERRCODE='check_violation'; END IF;
 END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER work_log_revisions_occurrence_guard BEFORE INSERT ON public.work_log_revisions FOR EACH ROW EXECUTE FUNCTION public.workloom_check_occurrence_revision();
--> statement-breakpoint
CREATE FUNCTION public.workloom_check_attendance_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE head jsonb; source public.work_logs%ROWTYPE; version public.work_log_revisions%ROWTYPE; posted jsonb;
BEGIN
 SELECT document INTO head FROM public.meeting_attendances WHERE workspace_id=NEW.workspace_id AND id=NEW.attendance_id AND revision=NEW.revision;
 IF NOT FOUND OR (head->'revision',head->'rosterActive',head->'status',head->'postingState',head->'minutes',head->'confirmedMeetingRevision') IS DISTINCT FROM (NEW.document->'revision',NEW.document->'rosterActive',NEW.document->'status',NEW.document->'postingState',NEW.document->'minutes',NEW.document->'confirmedMeetingRevision') THEN RAISE EXCEPTION 'Attendance history must match scoped presence head' USING ERRCODE='check_violation'; END IF;
 posted=NEW.document->'workLog';
 IF posted IS NOT NULL AND posted<>'null'::jsonb THEN
  SELECT * INTO source FROM public.work_logs WHERE workspace_id=NEW.workspace_id AND id=(posted->>'id')::uuid AND attendance_id=NEW.attendance_id;
  SELECT * INTO version FROM public.work_log_revisions WHERE workspace_id=NEW.workspace_id AND work_log_id=source.id AND id=(posted->>'revisionId')::uuid;
  IF source.id IS NULL OR version.id IS NULL OR version.revision<>(posted->>'revision')::integer OR version.minutes<>(posted->>'minutes')::integer OR version.state::text<>posted->>'state' THEN RAISE EXCEPTION 'Attendance posting must reference exact immutable source revision' USING ERRCODE='check_violation'; END IF;
 ELSIF NEW.document->>'postingState'<>'unconfirmed' THEN RAISE EXCEPTION 'Posted attendance requires work source' USING ERRCODE='check_violation';
 END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER meeting_attendance_revisions_head_guard BEFORE INSERT ON public.meeting_attendance_revisions FOR EACH ROW EXECUTE FUNCTION public.workloom_check_attendance_revision();
--> statement-breakpoint
CREATE TRIGGER meeting_revisions_immutable_rows BEFORE UPDATE OR DELETE ON public.meeting_revisions FOR EACH ROW EXECUTE FUNCTION public.workloom_reject_planning_history_mutation();
--> statement-breakpoint
CREATE TRIGGER meeting_revisions_immutable_truncate BEFORE TRUNCATE ON public.meeting_revisions FOR EACH STATEMENT EXECUTE FUNCTION public.workloom_reject_planning_history_mutation();
--> statement-breakpoint
CREATE TRIGGER meeting_attendance_revisions_immutable_rows BEFORE UPDATE OR DELETE ON public.meeting_attendance_revisions FOR EACH ROW EXECUTE FUNCTION public.workloom_reject_planning_history_mutation();
--> statement-breakpoint
CREATE TRIGGER meeting_attendance_revisions_immutable_truncate BEFORE TRUNCATE ON public.meeting_attendance_revisions FOR EACH STATEMENT EXECUTE FUNCTION public.workloom_reject_planning_history_mutation();
--> statement-breakpoint
CREATE TRIGGER meeting_schedule_locks_immutable_rows BEFORE UPDATE OR DELETE ON public.meeting_schedule_locks FOR EACH ROW EXECUTE FUNCTION public.workloom_reject_planning_history_mutation();
--> statement-breakpoint
CREATE TRIGGER meeting_schedule_locks_immutable_truncate BEFORE TRUNCATE ON public.meeting_schedule_locks FOR EACH STATEMENT EXECUTE FUNCTION public.workloom_reject_planning_history_mutation();
