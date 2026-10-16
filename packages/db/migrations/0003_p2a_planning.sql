CREATE TYPE "public"."baseline_mode" AS ENUM('manual', 'cutoff');--> statement-breakpoint
CREATE TYPE "public"."baseline_scope" AS ENUM('self', 'project');--> statement-breakpoint
CREATE TYPE "public"."commitment_state" AS ENUM('active', 'removed');--> statement-breakpoint
CREATE TYPE "public"."planning_lock_kind" AS ENUM('estimate', 'custom_value', 'commitment');--> statement-breakpoint
CREATE TYPE "public"."planning_period_state" AS ENUM('planning', 'frozen');--> statement-breakpoint
CREATE TYPE "public"."work_log_state" AS ENUM('active', 'void');--> statement-breakpoint
CREATE TABLE "commitment_allocations" (
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"commitment_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"minutes" integer NOT NULL,
	CONSTRAINT "commitment_allocations_pk" PRIMARY KEY("workspace_id","commitment_id","task_id"),
	CONSTRAINT "commitment_allocations_minutes" CHECK (minutes >= 0)
);
--> statement-breakpoint
CREATE TABLE "package_baselines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"work_package_id" uuid NOT NULL,
	"estimate_minutes" integer NOT NULL,
	"source_package_revision" integer NOT NULL,
	"source_baseline_id" uuid NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "package_baselines_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "package_baselines_package_unique" UNIQUE("workspace_id","work_package_id"),
	CONSTRAINT "package_baselines_values" CHECK (estimate_minutes >= 0 and source_package_revision >= 1)
);
--> statement-breakpoint
CREATE TABLE "package_freeze_observations" (
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"work_package_id" uuid NOT NULL,
	"estimate_minutes" integer,
	"package_revision" integer NOT NULL,
	"baseline_id" uuid NOT NULL,
	CONSTRAINT "package_freeze_observations_pk" PRIMARY KEY("workspace_id","work_package_id"),
	CONSTRAINT "package_freeze_observations_values" CHECK ((estimate_minutes is null or estimate_minutes >= 0) and package_revision >= 1)
);
--> statement-breakpoint
CREATE TABLE "period_commitment_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"commitment_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"change_seq" bigint NOT NULL,
	CONSTRAINT "period_commitment_revisions_source_unique" UNIQUE("workspace_id","commitment_id","revision"),
	CONSTRAINT "period_commitment_revisions_snapshot" CHECK ((jsonb_typeof(snapshot) = 'object' and snapshot->>'id' = commitment_id::text and (snapshot->>'revision')::integer = revision) is true),
	CONSTRAINT "period_commitment_revisions_positive" CHECK (revision >= 1 and change_seq >= 1)
);
--> statement-breakpoint
CREATE TABLE "period_commitments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"work_package_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"planned_minutes" integer,
	"state" "commitment_state" DEFAULT 'active' NOT NULL,
	"revision" integer NOT NULL,
	"added" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "period_commitments_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "period_commitments_scope_id_unique" UNIQUE("workspace_id","project_id","id"),
	CONSTRAINT "period_commitments_source_unique" UNIQUE("workspace_id","period_id","work_package_id","membership_id"),
	CONSTRAINT "period_commitments_minutes" CHECK (planned_minutes is null or planned_minutes >= 0),
	CONSTRAINT "period_commitments_revision" CHECK (revision >= 1)
);
--> statement-breakpoint
CREATE TABLE "plan_baselines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"scope" "baseline_scope" NOT NULL,
	"membership_id" uuid,
	"mode" "baseline_mode" NOT NULL,
	"requested_cutoff_at" timestamp with time zone NOT NULL,
	"frozen_at" timestamp with time zone NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"source" "command_source" NOT NULL,
	"change_seq" bigint NOT NULL,
	"snapshot" jsonb NOT NULL,
	CONSTRAINT "plan_baselines_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "plan_baselines_scope_id_unique" UNIQUE("workspace_id","project_id","id"),
	CONSTRAINT "plan_baselines_scope_member" CHECK ((scope = 'self') = (membership_id is not null)),
	CONSTRAINT "plan_baselines_seq" CHECK (change_seq >= 1),
	CONSTRAINT "plan_baselines_snapshot_scope" CHECK ((jsonb_typeof(snapshot) = 'object' and snapshot->>'schemaVersion' = '1' and snapshot#>>'{period,id}' = period_id::text and snapshot#>>'{period,workspaceId}' = workspace_id::text and snapshot#>>'{period,projectId}' = project_id::text) is true)
);
--> statement-breakpoint
CREATE TABLE "planning_locks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"baseline_id" uuid NOT NULL,
	"kind" "planning_lock_kind" NOT NULL,
	"work_package_id" uuid,
	"task_id" uuid,
	"field_id" uuid,
	"commitment_id" uuid,
	CONSTRAINT "planning_locks_shape" CHECK ((kind = 'estimate' and work_package_id is not null and task_id is null and field_id is null and commitment_id is null) or (kind = 'custom_value' and task_id is not null and field_id is not null and work_package_id is null and commitment_id is null) or (kind = 'commitment' and commitment_id is not null and work_package_id is null and task_id is null and field_id is null))
);
--> statement-breakpoint
CREATE TABLE "planning_periods" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"local_start" date NOT NULL,
	"local_end_exclusive" date NOT NULL,
	"timezone" text NOT NULL,
	"cutoff_at" timestamp with time zone NOT NULL,
	"state" "planning_period_state" DEFAULT 'planning' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"protected_field_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"protect_estimate" boolean DEFAULT true NOT NULL,
	"project_baseline_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "planning_periods_scope_id_unique" UNIQUE("workspace_id","project_id","id"),
	CONSTRAINT "planning_periods_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "planning_periods_project_week_unique" UNIQUE("workspace_id","project_id","local_start"),
	CONSTRAINT "planning_periods_week" CHECK (local_end_exclusive = local_start + 7),
	CONSTRAINT "planning_periods_revision" CHECK (revision >= 1),
	CONSTRAINT "planning_periods_name" CHECK (char_length(btrim(name)) between 1 and 160),
	CONSTRAINT "planning_periods_field_ids_array" CHECK (jsonb_typeof(protected_field_ids) = 'array'),
	CONSTRAINT "planning_periods_state_baseline" CHECK ((state = 'frozen') = (project_baseline_id is not null))
);
--> statement-breakpoint
CREATE TABLE "weekly_report_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"baseline_id" uuid NOT NULL,
	"document" jsonb NOT NULL,
	"rows" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "weekly_report_runs_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "weekly_report_runs_document_identity" CHECK ((jsonb_typeof(document) = 'object' and document->>'id' = id::text and document->>'workspaceId' = workspace_id::text and document->>'projectId' = project_id::text and document->>'periodId' = period_id::text and document->>'baselineId' = baseline_id::text and document->>'metricVersion' = 'weekly_plan_fact_v1' and jsonb_typeof(rows) = 'array' and jsonb_array_length(rows) = (document->>'rowCount')::integer) is true)
);
--> statement-breakpoint
CREATE TABLE "work_log_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"work_log_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"minutes" integer NOT NULL,
	"state" "work_log_state" NOT NULL,
	"reason" text,
	"actor_user_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"change_seq" bigint NOT NULL,
	CONSTRAINT "work_log_revisions_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "work_log_revisions_source_unique" UNIQUE("workspace_id","work_log_id","revision"),
	CONSTRAINT "work_log_revisions_values" CHECK (minutes >= 0 and revision >= 1 and change_seq >= 1),
	CONSTRAINT "work_log_revisions_reason" CHECK (((revision = 1 and state = 'active') or char_length(btrim(reason)) between 1 and 1000) is true)
);
--> statement-breakpoint
CREATE TABLE "work_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"work_package_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"source_kind" text DEFAULT 'manual_period' NOT NULL,
	"source_key" text NOT NULL,
	"revision" integer NOT NULL,
	"revision_id" uuid NOT NULL,
	CONSTRAINT "work_logs_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "work_logs_manual_source_unique" UNIQUE("workspace_id","task_id","membership_id","period_id"),
	CONSTRAINT "work_logs_source_key_unique" UNIQUE("workspace_id","source_kind","source_key"),
	CONSTRAINT "work_logs_source_identity" CHECK (source_kind = 'manual_period' and source_key = task_id::text || ':' || membership_id::text || ':' || period_id::text),
	CONSTRAINT "work_logs_revision" CHECK (revision >= 1)
);
--> statement-breakpoint
ALTER TABLE "commitment_allocations" ADD CONSTRAINT "commitment_allocations_commitment_fk" FOREIGN KEY ("workspace_id","project_id","commitment_id") REFERENCES "public"."period_commitments"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitment_allocations" ADD CONSTRAINT "commitment_allocations_task_fk" FOREIGN KEY ("workspace_id","project_id","task_id") REFERENCES "public"."tasks"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_baselines" ADD CONSTRAINT "package_baselines_package_fk" FOREIGN KEY ("workspace_id","project_id","work_package_id") REFERENCES "public"."work_packages"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_baselines" ADD CONSTRAINT "package_baselines_source_fk" FOREIGN KEY ("workspace_id","project_id","source_baseline_id") REFERENCES "public"."plan_baselines"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_freeze_observations" ADD CONSTRAINT "package_freeze_observations_package_fk" FOREIGN KEY ("workspace_id","project_id","work_package_id") REFERENCES "public"."work_packages"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_freeze_observations" ADD CONSTRAINT "package_freeze_observations_baseline_fk" FOREIGN KEY ("workspace_id","project_id","baseline_id") REFERENCES "public"."plan_baselines"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "period_commitment_revisions" ADD CONSTRAINT "period_commitment_revisions_source_fk" FOREIGN KEY ("workspace_id","commitment_id") REFERENCES "public"."period_commitments"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "period_commitment_revisions" ADD CONSTRAINT "period_commitment_revisions_actor_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "period_commitments" ADD CONSTRAINT "period_commitments_period_fk" FOREIGN KEY ("workspace_id","project_id","period_id") REFERENCES "public"."planning_periods"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "period_commitments" ADD CONSTRAINT "period_commitments_package_fk" FOREIGN KEY ("workspace_id","project_id","work_package_id") REFERENCES "public"."work_packages"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "period_commitments" ADD CONSTRAINT "period_commitments_member_fk" FOREIGN KEY ("workspace_id","membership_id") REFERENCES "public"."memberships"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_baselines" ADD CONSTRAINT "plan_baselines_period_fk" FOREIGN KEY ("workspace_id","project_id","period_id") REFERENCES "public"."planning_periods"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_baselines" ADD CONSTRAINT "plan_baselines_member_fk" FOREIGN KEY ("workspace_id","membership_id") REFERENCES "public"."memberships"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_baselines" ADD CONSTRAINT "plan_baselines_actor_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_locks" ADD CONSTRAINT "planning_locks_baseline_fk" FOREIGN KEY ("workspace_id","project_id","baseline_id") REFERENCES "public"."plan_baselines"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_locks" ADD CONSTRAINT "planning_locks_package_fk" FOREIGN KEY ("workspace_id","project_id","work_package_id") REFERENCES "public"."work_packages"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_locks" ADD CONSTRAINT "planning_locks_task_fk" FOREIGN KEY ("workspace_id","project_id","task_id") REFERENCES "public"."tasks"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_locks" ADD CONSTRAINT "planning_locks_field_fk" FOREIGN KEY ("workspace_id","project_id","field_id") REFERENCES "public"."task_field_definitions"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_locks" ADD CONSTRAINT "planning_locks_commitment_fk" FOREIGN KEY ("workspace_id","project_id","commitment_id") REFERENCES "public"."period_commitments"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_periods" ADD CONSTRAINT "planning_periods_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_report_runs" ADD CONSTRAINT "weekly_report_runs_period_fk" FOREIGN KEY ("workspace_id","project_id","period_id") REFERENCES "public"."planning_periods"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_report_runs" ADD CONSTRAINT "weekly_report_runs_baseline_fk" FOREIGN KEY ("workspace_id","project_id","baseline_id") REFERENCES "public"."plan_baselines"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_log_revisions" ADD CONSTRAINT "work_log_revisions_log_fk" FOREIGN KEY ("workspace_id","work_log_id") REFERENCES "public"."work_logs"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_log_revisions" ADD CONSTRAINT "work_log_revisions_actor_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_logs" ADD CONSTRAINT "work_logs_task_fk" FOREIGN KEY ("workspace_id","project_id","task_id") REFERENCES "public"."tasks"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_logs" ADD CONSTRAINT "work_logs_package_fk" FOREIGN KEY ("workspace_id","project_id","work_package_id") REFERENCES "public"."work_packages"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_logs" ADD CONSTRAINT "work_logs_period_fk" FOREIGN KEY ("workspace_id","project_id","period_id") REFERENCES "public"."planning_periods"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_logs" ADD CONSTRAINT "work_logs_member_fk" FOREIGN KEY ("workspace_id","membership_id") REFERENCES "public"."memberships"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "plan_baselines_personal_unique" ON "plan_baselines" USING btree ("workspace_id","period_id","membership_id") WHERE scope = 'self';--> statement-breakpoint
CREATE UNIQUE INDEX "plan_baselines_project_unique" ON "plan_baselines" USING btree ("workspace_id","period_id") WHERE scope = 'project';--> statement-breakpoint
CREATE UNIQUE INDEX "planning_locks_estimate_unique" ON "planning_locks" USING btree ("workspace_id","baseline_id","work_package_id") WHERE kind = 'estimate';--> statement-breakpoint
CREATE UNIQUE INDEX "planning_locks_value_unique" ON "planning_locks" USING btree ("workspace_id","baseline_id","task_id","field_id") WHERE kind = 'custom_value';--> statement-breakpoint
CREATE UNIQUE INDEX "planning_locks_commitment_unique" ON "planning_locks" USING btree ("workspace_id","baseline_id","commitment_id") WHERE kind = 'commitment';--> statement-breakpoint
-- Manual constraints and triggers are SQL-only; Drizzle snapshots describe the relational schema.
CREATE FUNCTION public.workloom_reject_planning_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Planning snapshots and revisions are append-only' USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER plan_baselines_immutable_rows BEFORE UPDATE OR DELETE ON public.plan_baselines FOR EACH ROW EXECUTE FUNCTION public.workloom_reject_planning_history_mutation();
--> statement-breakpoint
CREATE TRIGGER plan_baselines_immutable_truncate BEFORE TRUNCATE ON public.plan_baselines FOR EACH STATEMENT EXECUTE FUNCTION public.workloom_reject_planning_history_mutation();
--> statement-breakpoint
CREATE TRIGGER package_baselines_immutable_rows BEFORE UPDATE OR DELETE ON public.package_baselines FOR EACH ROW EXECUTE FUNCTION public.workloom_reject_planning_history_mutation();
--> statement-breakpoint
CREATE TRIGGER package_baselines_immutable_truncate BEFORE TRUNCATE ON public.package_baselines FOR EACH STATEMENT EXECUTE FUNCTION public.workloom_reject_planning_history_mutation();
--> statement-breakpoint
CREATE TRIGGER package_freeze_observations_immutable_rows BEFORE UPDATE OR DELETE ON public.package_freeze_observations FOR EACH ROW EXECUTE FUNCTION public.workloom_reject_planning_history_mutation();
--> statement-breakpoint
CREATE TRIGGER package_freeze_observations_immutable_truncate BEFORE TRUNCATE ON public.package_freeze_observations FOR EACH STATEMENT EXECUTE FUNCTION public.workloom_reject_planning_history_mutation();
--> statement-breakpoint
CREATE TRIGGER planning_locks_immutable_rows BEFORE UPDATE OR DELETE ON public.planning_locks FOR EACH ROW EXECUTE FUNCTION public.workloom_reject_planning_history_mutation();
--> statement-breakpoint
CREATE TRIGGER planning_locks_immutable_truncate BEFORE TRUNCATE ON public.planning_locks FOR EACH STATEMENT EXECUTE FUNCTION public.workloom_reject_planning_history_mutation();
--> statement-breakpoint
CREATE TRIGGER period_commitment_revisions_immutable_rows BEFORE UPDATE OR DELETE ON public.period_commitment_revisions FOR EACH ROW EXECUTE FUNCTION public.workloom_reject_planning_history_mutation();
--> statement-breakpoint
CREATE TRIGGER period_commitment_revisions_immutable_truncate BEFORE TRUNCATE ON public.period_commitment_revisions FOR EACH STATEMENT EXECUTE FUNCTION public.workloom_reject_planning_history_mutation();
--> statement-breakpoint
CREATE TRIGGER work_log_revisions_immutable_rows BEFORE UPDATE OR DELETE ON public.work_log_revisions FOR EACH ROW EXECUTE FUNCTION public.workloom_reject_planning_history_mutation();
--> statement-breakpoint
CREATE TRIGGER work_log_revisions_immutable_truncate BEFORE TRUNCATE ON public.work_log_revisions FOR EACH STATEMENT EXECUTE FUNCTION public.workloom_reject_planning_history_mutation();
--> statement-breakpoint
CREATE TRIGGER weekly_report_runs_immutable_rows BEFORE UPDATE OR DELETE ON public.weekly_report_runs FOR EACH ROW EXECUTE FUNCTION public.workloom_reject_planning_history_mutation();
--> statement-breakpoint
CREATE TRIGGER weekly_report_runs_immutable_truncate BEFORE TRUNCATE ON public.weekly_report_runs FOR EACH STATEMENT EXECUTE FUNCTION public.workloom_reject_planning_history_mutation();
--> statement-breakpoint
CREATE FUNCTION public.workloom_check_commitment_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.workspace_id,NEW.project_id,NEW.period_id,NEW.work_package_id,NEW.membership_id,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.workspace_id,OLD.project_id,OLD.period_id,OLD.work_package_id,OLD.membership_id,OLD.created_at) THEN
    RAISE EXCEPTION 'Commitment identity/provenance is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.added AND NOT NEW.added THEN RAISE EXCEPTION 'Added commitment provenance cannot be removed' USING ERRCODE = 'check_violation'; END IF;
  IF NEW.revision <> OLD.revision + 1 THEN RAISE EXCEPTION 'Commitment revision must advance once' USING ERRCODE = 'check_violation'; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER period_commitments_identity_guard BEFORE UPDATE ON public.period_commitments FOR EACH ROW EXECUTE FUNCTION public.workloom_check_commitment_identity();
--> statement-breakpoint
CREATE FUNCTION public.workloom_check_manual_work_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actual_package uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.id,NEW.workspace_id,NEW.project_id,NEW.task_id,NEW.work_package_id,NEW.membership_id,NEW.period_id,NEW.source_kind,NEW.source_key)
      IS DISTINCT FROM (OLD.id,OLD.workspace_id,OLD.project_id,OLD.task_id,OLD.work_package_id,OLD.membership_id,OLD.period_id,OLD.source_kind,OLD.source_key) THEN
      RAISE EXCEPTION 'Work source identity is immutable' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.revision <> OLD.revision + 1 THEN RAISE EXCEPTION 'Work revision must advance once' USING ERRCODE = 'check_violation'; END IF;
  ELSE
    IF NEW.revision <> 1 THEN RAISE EXCEPTION 'New work source starts at revision one' USING ERRCODE = 'check_violation'; END IF;
    SELECT work_package_id INTO actual_package FROM public.tasks WHERE workspace_id = NEW.workspace_id AND project_id = NEW.project_id AND id = NEW.task_id;
    IF FOUND AND actual_package IS DISTINCT FROM NEW.work_package_id THEN RAISE EXCEPTION 'Work source package must match task' USING ERRCODE = 'check_violation'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER work_logs_identity_guard BEFORE INSERT OR UPDATE ON public.work_logs FOR EACH ROW EXECUTE FUNCTION public.workloom_check_manual_work_identity();
--> statement-breakpoint
ALTER TABLE public.work_log_revisions ADD CONSTRAINT work_log_revisions_head_unique UNIQUE (workspace_id,work_log_id,revision,id);
--> statement-breakpoint
ALTER TABLE public.work_logs ADD CONSTRAINT work_logs_revision_head_fk FOREIGN KEY (workspace_id,id,revision,revision_id) REFERENCES public.work_log_revisions(workspace_id,work_log_id,revision,id) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE public.plan_baselines ADD CONSTRAINT plan_baselines_period_scope_id_unique UNIQUE (workspace_id,project_id,period_id,id);
--> statement-breakpoint
ALTER TABLE public.planning_periods ADD CONSTRAINT planning_periods_project_baseline_fk FOREIGN KEY (workspace_id,project_id,id,project_baseline_id) REFERENCES public.plan_baselines(workspace_id,project_id,period_id,id) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
CREATE FUNCTION public.workloom_check_allocation_package() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_package uuid; actual_package uuid;
BEGIN
  SELECT work_package_id INTO expected_package FROM public.period_commitments WHERE workspace_id=NEW.workspace_id AND project_id=NEW.project_id AND id=NEW.commitment_id;
  SELECT work_package_id INTO actual_package FROM public.tasks WHERE workspace_id=NEW.workspace_id AND project_id=NEW.project_id AND id=NEW.task_id;
  IF expected_package IS NOT NULL AND actual_package IS NOT NULL AND expected_package IS DISTINCT FROM actual_package THEN
    RAISE EXCEPTION 'Allocation task must belong to commitment package' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER commitment_allocations_package_guard BEFORE INSERT OR UPDATE ON public.commitment_allocations FOR EACH ROW EXECUTE FUNCTION public.workloom_check_allocation_package();
--> statement-breakpoint
CREATE FUNCTION public.workloom_check_first_package_baseline() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE first_row public.package_freeze_observations%ROWTYPE;
BEGIN
  SELECT * INTO first_row FROM public.package_freeze_observations WHERE workspace_id=NEW.workspace_id AND work_package_id=NEW.work_package_id;
  IF NOT FOUND OR first_row.estimate_minutes IS NULL OR
    (first_row.project_id,first_row.estimate_minutes,first_row.package_revision,first_row.baseline_id)
      IS DISTINCT FROM (NEW.project_id,NEW.estimate_minutes,NEW.source_package_revision,NEW.source_baseline_id) THEN
    RAISE EXCEPTION 'Original package baseline requires known first-related-freeze provenance' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER package_baselines_first_observation_guard BEFORE INSERT ON public.package_baselines FOR EACH ROW EXECUTE FUNCTION public.workloom_check_first_package_baseline();
