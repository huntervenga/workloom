CREATE TYPE "public"."recurrence_calendar_state" AS ENUM('scheduled', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."recurrence_exception_kind" AS ENUM('skip', 'move', 'restore', 'reset');--> statement-breakpoint
CREATE TYPE "public"."recurrence_series_state" AS ENUM('active', 'paused');--> statement-breakpoint
CREATE TABLE "recurrence_calendar_locks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"baseline_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"meeting_id" uuid,
	CONSTRAINT "recurrence_calendar_locks_baseline_instance_unique" UNIQUE("workspace_id","baseline_id","instance_id")
);
--> statement-breakpoint
CREATE TABLE "recurrence_exception_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"kind" "recurrence_exception_kind" NOT NULL,
	"local_date" date,
	"local_time" text,
	"reason" text NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"source" "command_source" NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"change_seq" bigint NOT NULL,
	CONSTRAINT "recurrence_exception_versions_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "recurrence_exception_versions_head_unique" UNIQUE("workspace_id","instance_id","id"),
	CONSTRAINT "recurrence_exception_versions_revision_unique" UNIQUE("workspace_id","instance_id","revision"),
	CONSTRAINT "recurrence_exception_versions_values" CHECK (revision >= 1 and change_seq >= 1 and char_length(btrim(reason)) between 1 and 1000),
	CONSTRAINT "recurrence_exception_versions_move_shape" CHECK (((kind = 'move' and local_date between '2000-01-01' and '2100-12-31' and local_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') or (kind <> 'move' and local_date is null and local_time is null)) is true)
);
--> statement-breakpoint
CREATE TABLE "recurrence_generation_authorizations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"series_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"authorizer_user_id" uuid NOT NULL,
	"authorizer_membership_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"source" "command_source" NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"change_seq" bigint NOT NULL,
	CONSTRAINT "recurrence_generation_authorizations_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "recurrence_generation_authorizations_head_unique" UNIQUE("workspace_id","series_id","id","revision"),
	CONSTRAINT "recurrence_generation_authorizations_revision_unique" UNIQUE("workspace_id","series_id","revision"),
	CONSTRAINT "recurrence_generation_authorizations_values" CHECK (revision >= 1 and change_seq >= 1)
);
--> statement-breakpoint
CREATE TABLE "recurrence_instances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"series_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"occurrence_key" date NOT NULL,
	"nominal_sequence" integer,
	"source_version_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"calendar_state" "recurrence_calendar_state" NOT NULL,
	"resolution" jsonb NOT NULL,
	"exception_version_id" uuid,
	"meeting_id" uuid,
	"task_id" uuid,
	"work_package_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "recurrence_instances_natural_key_unique" UNIQUE("workspace_id","series_id","occurrence_key"),
	CONSTRAINT "recurrence_instances_sequence_unique" UNIQUE("workspace_id","series_id","nominal_sequence"),
	CONSTRAINT "recurrence_instances_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "recurrence_instances_scope_id_unique" UNIQUE("workspace_id","project_id","id"),
	CONSTRAINT "recurrence_instances_meeting_lock_unique" UNIQUE("workspace_id","id","meeting_id"),
	CONSTRAINT "recurrence_instances_meeting_unique" UNIQUE("workspace_id","meeting_id"),
	CONSTRAINT "recurrence_instances_task_unique" UNIQUE("workspace_id","task_id"),
	CONSTRAINT "recurrence_instances_package_unique" UNIQUE("workspace_id","work_package_id"),
	CONSTRAINT "recurrence_instances_values" CHECK (revision >= 1 and occurrence_key between '2000-01-01' and '2100-12-31' and (nominal_sequence is null or nominal_sequence between 1 and 366)),
	CONSTRAINT "recurrence_instances_locator_all_or_none" CHECK (((meeting_id is null and task_id is null and work_package_id is null) or (meeting_id is not null and task_id is not null and work_package_id is not null)) is true),
	CONSTRAINT "recurrence_instances_resolution_shape" CHECK ((case when jsonb_typeof(resolution) = 'object' then
    resolution ?& array['policyVersion','intendedLocalDate','intendedLocalTime','resolvedStartAt','resolvedEndAt','resolvedLocalDate','resolvedLocalTime','resolvedOffset','plannedDurationMinutes','warning','provenance']
    and resolution - array['policyVersion','intendedLocalDate','intendedLocalTime','resolvedStartAt','resolvedEndAt','resolvedLocalDate','resolvedLocalTime','resolvedOffset','plannedDurationMinutes','warning','provenance'] = '{}'::jsonb
    and jsonb_typeof(resolution->'policyVersion') = 'string' and resolution->>'policyVersion' = 'first_valid_gap_earlier_overlap_v1'
    and jsonb_typeof(resolution->'intendedLocalDate') = 'string' and resolution->>'intendedLocalDate' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' and resolution->>'intendedLocalDate' between '2000-01-01' and '2100-12-31'
    and jsonb_typeof(resolution->'resolvedLocalDate') = 'string' and resolution->>'resolvedLocalDate' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' and resolution->>'resolvedLocalDate' between '2000-01-01' and '2100-12-31'
    and jsonb_typeof(resolution->'intendedLocalTime') = 'string' and resolution->>'intendedLocalTime' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    and jsonb_typeof(resolution->'resolvedLocalTime') = 'string' and resolution->>'resolvedLocalTime' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    and jsonb_typeof(resolution->'resolvedStartAt') = 'string' and resolution->>'resolvedStartAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]+)?)?Z$'
    and jsonb_typeof(resolution->'resolvedEndAt') = 'string' and resolution->>'resolvedEndAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]+)?)?Z$'
    and jsonb_typeof(resolution->'resolvedOffset') = 'string' and resolution->>'resolvedOffset' ~ '^[+-]([01][0-9]|2[0-3]):[0-5][0-9]$'
    and case when jsonb_typeof(resolution->'plannedDurationMinutes') = 'number' then (resolution->'plannedDurationMinutes')::numeric between 1 and 1440 and (resolution->'plannedDurationMinutes')::numeric = trunc((resolution->'plannedDurationMinutes')::numeric) else false end
    and (jsonb_typeof(resolution->'warning') = 'null' or (jsonb_typeof(resolution->'warning') = 'string' and resolution->>'warning' in ('ambiguous_earlier','gap_first_valid','skipped_local_date')))
    and case when jsonb_typeof(resolution->'provenance') = 'object' then
      resolution->'provenance' ?& array['timezone','implementation','tzdataVersion','icuVersion']
      and (resolution->'provenance') - array['timezone','implementation','tzdataVersion','icuVersion'] = '{}'::jsonb
      and jsonb_typeof(resolution#>'{provenance,timezone}') = 'string' and char_length(resolution#>>'{provenance,timezone}') between 1 and 100
      and jsonb_typeof(resolution#>'{provenance,implementation}') = 'string' and char_length(resolution#>>'{provenance,implementation}') between 1 and 100
      and (jsonb_typeof(resolution#>'{provenance,tzdataVersion}') = 'null' or (jsonb_typeof(resolution#>'{provenance,tzdataVersion}') = 'string' and char_length(resolution#>>'{provenance,tzdataVersion}') between 1 and 40))
      and (jsonb_typeof(resolution#>'{provenance,icuVersion}') = 'null' or (jsonb_typeof(resolution#>'{provenance,icuVersion}') = 'string' and char_length(resolution#>>'{provenance,icuVersion}') between 1 and 40))
    else false end
  else false end) is true)
);
--> statement-breakpoint
CREATE TABLE "recurrence_period_bindings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"series_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"source_manifest_hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "recurrence_period_bindings_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "recurrence_period_bindings_series_period_unique" UNIQUE("workspace_id","series_id","period_id"),
	CONSTRAINT "recurrence_period_bindings_source_unique" UNIQUE("workspace_id","project_id","series_id","id","period_id"),
	CONSTRAINT "recurrence_period_bindings_revision" CHECK (revision >= 1),
	CONSTRAINT "recurrence_period_bindings_hash" CHECK (source_manifest_hash ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "recurrence_series" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"state" "recurrence_series_state" NOT NULL,
	"current_version_id" uuid NOT NULL,
	"authorization_id" uuid,
	"authorization_revision" integer,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "recurrence_series_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "recurrence_series_scope_id_unique" UNIQUE("workspace_id","project_id","id"),
	CONSTRAINT "recurrence_series_revision" CHECK (revision >= 1),
	CONSTRAINT "recurrence_series_authorization_pair" CHECK (((authorization_id is null and authorization_revision is null) or (authorization_id is not null and authorization_revision >= 1)) is true)
);
--> statement-breakpoint
CREATE TABLE "recurrence_series_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"series_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"effective_from_nominal_date" date NOT NULL,
	"schedule" jsonb NOT NULL,
	"template" jsonb NOT NULL,
	"policy_version" text NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"source" "command_source" NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"change_seq" bigint NOT NULL,
	CONSTRAINT "recurrence_series_versions_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "recurrence_series_versions_head_unique" UNIQUE("workspace_id","project_id","series_id","id"),
	CONSTRAINT "recurrence_series_versions_revision_unique" UNIQUE("workspace_id","series_id","revision"),
	CONSTRAINT "recurrence_series_versions_values" CHECK (revision >= 1 and change_seq >= 1 and policy_version = 'first_valid_gap_earlier_overlap_v1' and effective_from_nominal_date between '2000-01-01' and '2100-12-31'),
	CONSTRAINT "recurrence_series_versions_schedule_shape" CHECK ((case when jsonb_typeof(schedule) = 'object' then
    schedule ?& array['startDate','localTime','timezone','frequency','plannedDurationMinutes','end']
    and schedule - array['startDate','localTime','timezone','frequency','weekdays','plannedDurationMinutes','end'] = '{}'::jsonb
    and jsonb_typeof(schedule->'startDate') = 'string' and schedule->>'startDate' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' and schedule->>'startDate' between '2000-01-01' and '2100-12-31'
    and jsonb_typeof(schedule->'localTime') = 'string' and schedule->>'localTime' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    and jsonb_typeof(schedule->'timezone') = 'string' and char_length(schedule->>'timezone') between 1 and 100
    and case when jsonb_typeof(schedule->'plannedDurationMinutes') = 'number' then (schedule->'plannedDurationMinutes')::numeric between 1 and 1440 and (schedule->'plannedDurationMinutes')::numeric = trunc((schedule->'plannedDurationMinutes')::numeric) else false end
    and case
      when schedule->>'frequency' = 'daily' then not schedule ? 'weekdays'
      when schedule->>'frequency' = 'weekly' then case when jsonb_typeof(schedule->'weekdays') = 'array' then jsonb_array_length(schedule->'weekdays') between 1 and 7 and not jsonb_path_exists(schedule->'weekdays', '$[*] ? (@.type() != "number" || @ < 1 || @ > 7 || @.floor() != @)') else false end
      else false end
    and case when jsonb_typeof(schedule->'end') = 'object' then case
      when schedule#>>'{end,kind}' = 'on_date' then (schedule->'end') - 'kind' - 'endDate' = '{}'::jsonb and jsonb_typeof(schedule#>'{end,endDate}') = 'string' and schedule#>>'{end,endDate}' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' and schedule#>>'{end,endDate}' between schedule->>'startDate' and '2100-12-31'
      when schedule#>>'{end,kind}' = 'after_count' then (schedule->'end') - 'kind' - 'count' = '{}'::jsonb and case when jsonb_typeof(schedule#>'{end,count}') = 'number' then (schedule#>'{end,count}')::numeric between 1 and 366 and (schedule#>'{end,count}')::numeric = trunc((schedule#>'{end,count}')::numeric) else false end
      else false end else false end
  else false end) is true),
	CONSTRAINT "recurrence_series_versions_template_shape" CHECK ((case when jsonb_typeof(template) = 'object' then
    template ?& array['title','statusId','organizerMembershipId','attendeeMembershipIds']
    and template - array['title','statusId','sectionId','organizerMembershipId','attendeeMembershipIds','joinUrl'] = '{}'::jsonb
    and jsonb_typeof(template->'title') = 'string' and char_length(btrim(template->>'title')) between 1 and 500
    and jsonb_typeof(template->'statusId') = 'string' and template->>'statusId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and jsonb_typeof(template->'organizerMembershipId') = 'string' and template->>'organizerMembershipId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and (not template ? 'sectionId' or jsonb_typeof(template->'sectionId') = 'null' or (jsonb_typeof(template->'sectionId') = 'string' and template->>'sectionId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
    and case when jsonb_typeof(template->'attendeeMembershipIds') = 'array' then jsonb_array_length(template->'attendeeMembershipIds') between 1 and 100 and not jsonb_path_exists(template->'attendeeMembershipIds', '$[*] ? (@.type() != "string" || !(@ like_regex "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"))') else false end
    and (not template ? 'joinUrl' or jsonb_typeof(template->'joinUrl') = 'null' or (jsonb_typeof(template->'joinUrl') = 'string' and char_length(template->>'joinUrl') <= 2048 and template->>'joinUrl' ~* '^https?://'))
  else false end) is true)
);
--> statement-breakpoint
ALTER TABLE "recurrence_calendar_locks" ADD CONSTRAINT "recurrence_calendar_locks_baseline_fk" FOREIGN KEY ("workspace_id","project_id","baseline_id") REFERENCES "public"."plan_baselines"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurrence_calendar_locks" ADD CONSTRAINT "recurrence_calendar_locks_instance_fk" FOREIGN KEY ("workspace_id","project_id","instance_id") REFERENCES "public"."recurrence_instances"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurrence_calendar_locks" ADD CONSTRAINT "recurrence_calendar_locks_instance_meeting_fk" FOREIGN KEY ("workspace_id","instance_id","meeting_id") REFERENCES "public"."recurrence_instances"("workspace_id","id","meeting_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurrence_calendar_locks" ADD CONSTRAINT "recurrence_calendar_locks_meeting_fk" FOREIGN KEY ("workspace_id","project_id","meeting_id") REFERENCES "public"."meetings"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurrence_exception_versions" ADD CONSTRAINT "recurrence_exception_versions_instance_fk" FOREIGN KEY ("workspace_id","project_id","instance_id") REFERENCES "public"."recurrence_instances"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurrence_exception_versions" ADD CONSTRAINT "recurrence_exception_versions_actor_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurrence_generation_authorizations" ADD CONSTRAINT "recurrence_generation_authorizations_series_fk" FOREIGN KEY ("workspace_id","project_id","series_id") REFERENCES "public"."recurrence_series"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurrence_generation_authorizations" ADD CONSTRAINT "recurrence_generation_authorizations_membership_fk" FOREIGN KEY ("workspace_id","authorizer_membership_id") REFERENCES "public"."memberships"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurrence_generation_authorizations" ADD CONSTRAINT "recurrence_generation_authorizations_authorizer_fk" FOREIGN KEY ("workspace_id","authorizer_user_id") REFERENCES "public"."memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurrence_generation_authorizations" ADD CONSTRAINT "recurrence_generation_authorizations_actor_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurrence_instances" ADD CONSTRAINT "recurrence_instances_series_fk" FOREIGN KEY ("workspace_id","project_id","series_id") REFERENCES "public"."recurrence_series"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurrence_instances" ADD CONSTRAINT "recurrence_instances_binding_fk" FOREIGN KEY ("workspace_id","project_id","series_id","binding_id","period_id") REFERENCES "public"."recurrence_period_bindings"("workspace_id","project_id","series_id","id","period_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurrence_instances" ADD CONSTRAINT "recurrence_instances_source_version_fk" FOREIGN KEY ("workspace_id","project_id","series_id","source_version_id") REFERENCES "public"."recurrence_series_versions"("workspace_id","project_id","series_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurrence_instances" ADD CONSTRAINT "recurrence_instances_meeting_fk" FOREIGN KEY ("workspace_id","project_id","meeting_id") REFERENCES "public"."meetings"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurrence_instances" ADD CONSTRAINT "recurrence_instances_meeting_source_fk" FOREIGN KEY ("workspace_id","meeting_id","task_id","period_id") REFERENCES "public"."meetings"("workspace_id","id","task_id","planned_period_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurrence_instances" ADD CONSTRAINT "recurrence_instances_task_fk" FOREIGN KEY ("workspace_id","project_id","task_id") REFERENCES "public"."tasks"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurrence_instances" ADD CONSTRAINT "recurrence_instances_package_fk" FOREIGN KEY ("workspace_id","project_id","work_package_id") REFERENCES "public"."work_packages"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurrence_period_bindings" ADD CONSTRAINT "recurrence_period_bindings_series_fk" FOREIGN KEY ("workspace_id","project_id","series_id") REFERENCES "public"."recurrence_series"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurrence_period_bindings" ADD CONSTRAINT "recurrence_period_bindings_period_fk" FOREIGN KEY ("workspace_id","project_id","period_id") REFERENCES "public"."planning_periods"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurrence_series" ADD CONSTRAINT "recurrence_series_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurrence_series_versions" ADD CONSTRAINT "recurrence_series_versions_series_fk" FOREIGN KEY ("workspace_id","project_id","series_id") REFERENCES "public"."recurrence_series"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurrence_series_versions" ADD CONSTRAINT "recurrence_series_versions_actor_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recurrence_calendar_locks_instance_idx" ON "recurrence_calendar_locks" USING btree ("workspace_id","instance_id");--> statement-breakpoint
CREATE INDEX "recurrence_instances_binding_idx" ON "recurrence_instances" USING btree ("workspace_id","binding_id","occurrence_key");--> statement-breakpoint
CREATE INDEX "recurrence_period_bindings_period_idx" ON "recurrence_period_bindings" USING btree ("workspace_id","period_id","series_id");--> statement-breakpoint
CREATE INDEX "recurrence_series_project_idx" ON "recurrence_series" USING btree ("workspace_id","project_id","state","id");--> statement-breakpoint
CREATE INDEX "recurrence_series_versions_effective_idx" ON "recurrence_series_versions" USING btree ("workspace_id","series_id","effective_from_nominal_date","revision");
--> statement-breakpoint
-- P3b hardening (SQL-only, like 0005 head FKs/triggers; the Drizzle snapshot stays generator-owned).
-- Circular head references are DEFERRABLE INITIALLY DEFERRED so a head row and its first version/grant/exception
-- can be written in either order inside one transaction. Target uniques are created with the tables above.
ALTER TABLE public.recurrence_series ADD CONSTRAINT recurrence_series_current_version_fk FOREIGN KEY(workspace_id,project_id,id,current_version_id) REFERENCES public.recurrence_series_versions(workspace_id,project_id,series_id,id) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE public.recurrence_series ADD CONSTRAINT recurrence_series_authorization_fk FOREIGN KEY(workspace_id,id,authorization_id,authorization_revision) REFERENCES public.recurrence_generation_authorizations(workspace_id,series_id,id,revision) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE public.recurrence_instances ADD CONSTRAINT recurrence_instances_exception_head_fk FOREIGN KEY(workspace_id,id,exception_version_id) REFERENCES public.recurrence_exception_versions(workspace_id,instance_id,id) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
-- Same 42501 as workloom_reject_planning_history_mutation, with a recurrence-specific message.
CREATE FUNCTION public.workloom_reject_recurrence_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Recurrence history and census are append-only' USING ERRCODE='insufficient_privilege';
END; $$;
--> statement-breakpoint
-- Exception-safe parsers: NULL instead of a cast error, so malformed values surface as clear 23514 guards.
-- Dates must round-trip exactly (no 02-30 roll-over) and stay inside the supported 2000-01-01..2100-12-31 range.
CREATE FUNCTION public.workloom_recurrence_date(value text) RETURNS date LANGUAGE plpgsql STABLE AS $$
DECLARE result date;
BEGIN
 IF value IS NULL OR value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN NULL; END IF;
 BEGIN result:=value::date; EXCEPTION WHEN others THEN RETURN NULL; END;
 IF to_char(result,'YYYY-MM-DD')<>value OR result<DATE '2000-01-01' OR result>DATE '2100-12-31' THEN RETURN NULL; END IF;
 RETURN result;
END; $$;
--> statement-breakpoint
-- Exact UTC ISO instant (zod iso.datetime form); 24:00 and leap-second roll-overs fail the round-trip.
CREATE FUNCTION public.workloom_recurrence_instant(value text) RETURNS timestamptz LANGUAGE plpgsql STABLE AS $$
DECLARE result timestamptz;
BEGIN
 IF value IS NULL OR value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]+)?)?Z$' THEN RETURN NULL; END IF;
 BEGIN result:=value::timestamptz; EXCEPTION WHEN others THEN RETURN NULL; END;
 IF to_char(result AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI')<>left(value,16) THEN RETURN NULL; END IF;
 RETURN result;
END; $$;
--> statement-breakpoint
-- Order-insensitive weekday set; NULL when absent (daily).
CREATE FUNCTION public.workloom_recurrence_weekday_set(weekdays jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN jsonb_typeof(weekdays)='array' THEN (SELECT jsonb_agg(DISTINCT w ORDER BY w) FROM jsonb_array_elements(weekdays) w) END
$$;
--> statement-breakpoint
-- Version validity. AFTER INSERT: the declarative shape CHECKs have already passed, so the guarded casts below
-- cannot hit malformed JSON. Template references are checked for existence/scope only at insert: rows are
-- immutable, so later archived sections or revoked memberships keep old history valid; active rights stay in the domain.
-- Later writes need a strictly higher revision; boundaries may repeat (highest revision at/before a date wins).
-- startDate/end kind never change; after_count also freezes frequency/weekday set/count (immutable sequence).
CREATE FUNCTION public.workloom_check_recurrence_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s jsonb:=NEW.schedule; t jsonb:=NEW.template; start_date date; end_date date; first_row public.recurrence_series_versions%ROWTYPE; latest integer;
BEGIN
 start_date:=public.workloom_recurrence_date(s->>'startDate');
 IF start_date IS NULL THEN RAISE EXCEPTION 'Recurrence start date must be a real supported date' USING ERRCODE='check_violation'; END IF;
 IF s#>>'{end,kind}'='on_date' THEN
  end_date:=public.workloom_recurrence_date(s#>>'{end,endDate}');
  IF end_date IS NULL OR end_date<start_date OR end_date-start_date+1>366 THEN RAISE EXCEPTION 'Recurrence end date must be a real date within 366 days of the start' USING ERRCODE='check_violation'; END IF;
 END IF;
 IF s->>'frequency'='weekly' AND jsonb_array_length(public.workloom_recurrence_weekday_set(s->'weekdays'))<>jsonb_array_length(s->'weekdays') THEN RAISE EXCEPTION 'Recurrence weekdays must be unique ISO weekdays' USING ERRCODE='check_violation'; END IF;
 IF NEW.effective_from_nominal_date<start_date THEN RAISE EXCEPTION 'Recurrence version cannot take effect before the series start' USING ERRCODE='check_violation'; END IF;
 SELECT max(revision) INTO latest FROM public.recurrence_series_versions WHERE workspace_id=NEW.workspace_id AND series_id=NEW.series_id AND id<>NEW.id;
 IF latest IS NOT NULL AND NEW.revision<=latest THEN RAISE EXCEPTION 'Recurrence version revision must increase' USING ERRCODE='check_violation'; END IF;
 SELECT * INTO first_row FROM public.recurrence_series_versions WHERE workspace_id=NEW.workspace_id AND series_id=NEW.series_id AND id<>NEW.id ORDER BY revision LIMIT 1;
 IF NOT FOUND THEN
  IF NEW.effective_from_nominal_date<>start_date THEN RAISE EXCEPTION 'First recurrence version takes effect at the series start' USING ERRCODE='check_violation'; END IF;
 ELSIF (s->'startDate',s#>'{end,kind}') IS DISTINCT FROM (first_row.schedule->'startDate',first_row.schedule#>'{end,kind}') THEN
  RAISE EXCEPTION 'Recurrence start date and end kind are immutable' USING ERRCODE='check_violation';
 ELSIF first_row.schedule#>>'{end,kind}'='after_count' AND (s->'frequency',public.workloom_recurrence_weekday_set(s->'weekdays'),(s#>>'{end,count}')::numeric) IS DISTINCT FROM (first_row.schedule->'frequency',public.workloom_recurrence_weekday_set(first_row.schedule->'weekdays'),(first_row.schedule#>>'{end,count}')::numeric) THEN
  RAISE EXCEPTION 'after_count nominal sequence is immutable' USING ERRCODE='check_violation';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.task_statuses WHERE workspace_id=NEW.workspace_id AND project_id=NEW.project_id AND id=(t->>'statusId')::uuid) THEN RAISE EXCEPTION 'Recurrence template status must belong to the series project' USING ERRCODE='check_violation'; END IF;
 IF jsonb_typeof(t->'sectionId')='string' AND NOT EXISTS(SELECT 1 FROM public.sections WHERE workspace_id=NEW.workspace_id AND project_id=NEW.project_id AND id=(t->>'sectionId')::uuid) THEN RAISE EXCEPTION 'Recurrence template section must belong to the series project' USING ERRCODE='check_violation'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.memberships WHERE workspace_id=NEW.workspace_id AND id=(t->>'organizerMembershipId')::uuid) THEN RAISE EXCEPTION 'Recurrence organizer must be a workspace membership' USING ERRCODE='check_violation'; END IF;
 IF (SELECT count(DISTINCT a) FROM jsonb_array_elements_text(t->'attendeeMembershipIds') a)<>jsonb_array_length(t->'attendeeMembershipIds')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(t->'attendeeMembershipIds') a WHERE NOT EXISTS(SELECT 1 FROM public.memberships m WHERE m.workspace_id=NEW.workspace_id AND m.id=a::uuid)) THEN
  RAISE EXCEPTION 'Recurrence attendees must be unique workspace memberships' USING ERRCODE='check_violation';
 END IF;
 RETURN NULL;
END; $$;
--> statement-breakpoint
CREATE TRIGGER recurrence_series_versions_validity AFTER INSERT ON public.recurrence_series_versions FOR EACH ROW EXECUTE FUNCTION public.workloom_check_recurrence_version();
--> statement-breakpoint
-- Grants: authorizer membership/user pair must match and be active at grant time; only the current actor
-- authorizes, for themself (no owner/organizer impersonation); revisions strictly increase.
CREATE FUNCTION public.workloom_check_recurrence_authorization() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE latest integer;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.memberships WHERE workspace_id=NEW.workspace_id AND id=NEW.authorizer_membership_id AND user_id=NEW.authorizer_user_id AND state='active') THEN RAISE EXCEPTION 'Generation authorizer must be the active membership of the authorizing user' USING ERRCODE='check_violation'; END IF;
 IF NEW.actor_user_id<>NEW.authorizer_user_id THEN RAISE EXCEPTION 'Generation is authorized only by the current actor' USING ERRCODE='check_violation'; END IF;
 SELECT max(revision) INTO latest FROM public.recurrence_generation_authorizations WHERE workspace_id=NEW.workspace_id AND series_id=NEW.series_id AND id<>NEW.id;
 IF latest IS NOT NULL AND NEW.revision<=latest THEN RAISE EXCEPTION 'Generation authorization revision must increase' USING ERRCODE='check_violation'; END IF;
 RETURN NULL;
END; $$;
--> statement-breakpoint
CREATE TRIGGER recurrence_generation_authorizations_validity AFTER INSERT ON public.recurrence_generation_authorizations FOR EACH ROW EXECUTE FUNCTION public.workloom_check_recurrence_authorization();
--> statement-breakpoint
-- Series head: immutable identity, starts at revision one, revision strictly increases on any change,
-- a grant is replaced but never cleared. No-op updates pass.
CREATE FUNCTION public.workloom_check_recurrence_series() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.revision<>1 THEN RAISE EXCEPTION 'Recurrence series starts at revision one' USING ERRCODE='check_violation'; END IF;
 ELSIF NEW IS DISTINCT FROM OLD THEN
  IF (NEW.id,NEW.workspace_id,NEW.project_id,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.workspace_id,OLD.project_id,OLD.created_at) THEN RAISE EXCEPTION 'Recurrence series identity is immutable' USING ERRCODE='check_violation'; END IF;
  IF NEW.revision<=OLD.revision THEN RAISE EXCEPTION 'Recurrence series revision must increase' USING ERRCODE='check_violation'; END IF;
  IF OLD.authorization_id IS NOT NULL AND NEW.authorization_id IS NULL THEN RAISE EXCEPTION 'Generation authorization is replaced, never cleared' USING ERRCODE='check_violation'; END IF;
 END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER recurrence_series_identity_guard BEFORE INSERT OR UPDATE ON public.recurrence_series FOR EACH ROW EXECUTE FUNCTION public.workloom_check_recurrence_series();
--> statement-breakpoint
-- Deferred head consistency (re-reads committed-to-be state, not the stale trigger NEW): the current version is the
-- latest-written revision of the same series; a non-null grant pair is the latest grant of the same series.
CREATE FUNCTION public.workloom_check_recurrence_series_head() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_series uuid; head public.recurrence_series%ROWTYPE; current_revision integer; latest integer; latest_grant integer;
BEGIN
 IF TG_TABLE_NAME='recurrence_series' THEN target_series:=NEW.id; ELSE target_series:=NEW.series_id; END IF;
 SELECT * INTO head FROM public.recurrence_series WHERE workspace_id=NEW.workspace_id AND id=target_series;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT max(revision) INTO latest FROM public.recurrence_series_versions WHERE workspace_id=head.workspace_id AND series_id=head.id;
 SELECT revision INTO current_revision FROM public.recurrence_series_versions WHERE workspace_id=head.workspace_id AND project_id=head.project_id AND series_id=head.id AND id=head.current_version_id;
 IF current_revision IS NULL OR current_revision<>latest THEN RAISE EXCEPTION 'Recurrence series must point to its latest-written version' USING ERRCODE='check_violation'; END IF;
 SELECT max(revision) INTO latest_grant FROM public.recurrence_generation_authorizations WHERE workspace_id=head.workspace_id AND series_id=head.id;
 IF (latest_grant IS NULL AND head.authorization_id IS NOT NULL)
  OR (latest_grant IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.recurrence_generation_authorizations WHERE workspace_id=head.workspace_id AND project_id=head.project_id AND series_id=head.id AND id=head.authorization_id AND revision=head.authorization_revision AND revision=latest_grant)) THEN
  RAISE EXCEPTION 'Recurrence series must point to its latest generation authorization' USING ERRCODE='check_violation';
 END IF;
 RETURN NULL;
END; $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER recurrence_series_head_check AFTER INSERT OR UPDATE ON public.recurrence_series DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.workloom_check_recurrence_series_head();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER recurrence_series_versions_head_check AFTER INSERT ON public.recurrence_series_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.workloom_check_recurrence_series_head();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER recurrence_generation_authorizations_head_check AFTER INSERT ON public.recurrence_generation_authorizations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.workloom_check_recurrence_series_head();
--> statement-breakpoint
-- Bindings: immutable series/period ownership, at most 52 per series, revision one then strictly increasing.
CREATE FUNCTION public.workloom_check_recurrence_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.revision<>1 THEN RAISE EXCEPTION 'Recurrence binding starts at revision one' USING ERRCODE='check_violation'; END IF;
  IF (SELECT count(*) FROM public.recurrence_period_bindings WHERE workspace_id=NEW.workspace_id AND series_id=NEW.series_id)>=52 THEN RAISE EXCEPTION 'A recurrence series binds at most 52 periods' USING ERRCODE='check_violation'; END IF;
 ELSIF NEW IS DISTINCT FROM OLD THEN
  IF (NEW.id,NEW.workspace_id,NEW.project_id,NEW.series_id,NEW.period_id,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.workspace_id,OLD.project_id,OLD.series_id,OLD.period_id,OLD.created_at) THEN RAISE EXCEPTION 'Recurrence binding ownership is immutable' USING ERRCODE='check_violation'; END IF;
  IF NEW.revision<=OLD.revision THEN RAISE EXCEPTION 'Recurrence binding revision must increase' USING ERRCODE='check_violation'; END IF;
 END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER recurrence_period_bindings_identity_guard BEFORE INSERT OR UPDATE ON public.recurrence_period_bindings FOR EACH ROW EXECUTE FUNCTION public.workloom_check_recurrence_binding();
--> statement-breakpoint
-- Headers: immutable natural key/sequence/binding/period/series/project; revision one then strictly increasing;
-- the locator attaches once (null to all three) and is never replaced or cleared; an exception head is never cleared
-- (reset is itself a version). A calendar-locked header rejects any planned/calendar change even when it never got
-- a meeting. Real meeting writes are not touched here (P3a schedule locks own those).
CREATE FUNCTION public.workloom_check_recurrence_instance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE attaching boolean; m public.meetings%ROWTYPE;
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.revision<>1 OR NEW.exception_version_id IS NOT NULL THEN RAISE EXCEPTION 'Recurrence header starts at revision one without an exception' USING ERRCODE='check_violation'; END IF;
  attaching:=NEW.meeting_id IS NOT NULL;
 ELSE
  attaching:=OLD.meeting_id IS NULL AND NEW.meeting_id IS NOT NULL;
  IF NEW IS DISTINCT FROM OLD THEN
   IF (NEW.id,NEW.workspace_id,NEW.project_id,NEW.series_id,NEW.binding_id,NEW.period_id,NEW.occurrence_key,NEW.nominal_sequence,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.workspace_id,OLD.project_id,OLD.series_id,OLD.binding_id,OLD.period_id,OLD.occurrence_key,OLD.nominal_sequence,OLD.created_at) THEN RAISE EXCEPTION 'Recurrence header identity is immutable' USING ERRCODE='check_violation'; END IF;
   IF NEW.revision<=OLD.revision THEN RAISE EXCEPTION 'Recurrence header revision must increase' USING ERRCODE='check_violation'; END IF;
   IF OLD.meeting_id IS NOT NULL AND (NEW.meeting_id,NEW.task_id,NEW.work_package_id) IS DISTINCT FROM (OLD.meeting_id,OLD.task_id,OLD.work_package_id) THEN RAISE EXCEPTION 'Recurrence locator attaches once' USING ERRCODE='check_violation'; END IF;
   IF OLD.exception_version_id IS NOT NULL AND NEW.exception_version_id IS NULL THEN RAISE EXCEPTION 'Recurrence exception head is never cleared' USING ERRCODE='check_violation'; END IF;
   IF (NEW.calendar_state,NEW.resolution,NEW.source_version_id,NEW.exception_version_id,NEW.meeting_id,NEW.task_id,NEW.work_package_id) IS DISTINCT FROM (OLD.calendar_state,OLD.resolution,OLD.source_version_id,OLD.exception_version_id,OLD.meeting_id,OLD.task_id,OLD.work_package_id)
    AND EXISTS(SELECT 1 FROM public.recurrence_calendar_locks WHERE workspace_id=NEW.workspace_id AND instance_id=NEW.id) THEN
    RAISE EXCEPTION 'Recurrence header is calendar-frozen' USING ERRCODE='check_violation';
   END IF;
  END IF;
 END IF;
 IF attaching THEN
  SELECT * INTO m FROM public.meetings WHERE workspace_id=NEW.workspace_id AND id=NEW.meeting_id;
  IF NOT FOUND OR (m.project_id,m.task_id,m.work_package_id,m.planned_period_id) IS DISTINCT FROM (NEW.project_id,NEW.task_id,NEW.work_package_id,NEW.period_id) THEN
   RAISE EXCEPTION 'Recurrence locator must be the real meeting of this header period and own its task/package' USING ERRCODE='check_violation';
  END IF;
 END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER recurrence_instances_identity_guard BEFORE INSERT OR UPDATE ON public.recurrence_instances FOR EACH ROW EXECUTE FUNCTION public.workloom_check_recurrence_instance();
--> statement-breakpoint
-- Header coherence, checked at commit from the final rows.
-- All headers: source version of the same series; exception head is the latest exception (or none exists);
-- skip => cancelled, move => scheduled; sequence present (<= count) iff after_count; key not before series start;
-- resolution is tzdata-independent coherent: exact minute instants, end = start + elapsed duration,
-- resolved wall time = start + stored offset (a non-minute real offset cannot be rounded into this), warning matches.
-- Scheduled headers additionally use their version zone/duration; move intends the move date/time; restore/none/reset
-- intend the nominal key at the version local time; none/reset also require the highest-revision version effective
-- at/before the key and a key the rule actually generates. Cancelled headers (incl. never-materialized, null locator)
-- stay valid census and may keep an older version as history. PG tzdata may differ from runtime ICU, so the
-- offset-versus-zone and period-boundary checks remain in the shared resolver/domain.
CREATE FUNCTION public.workloom_recurrence_assert_instance(target_workspace uuid,target_instance uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE h public.recurrence_instances%ROWTYPE; v public.recurrence_series_versions%ROWTYPE; e public.recurrence_exception_versions%ROWTYPE;
 r jsonb; head_kind text:='none'; latest integer; start_at timestamptz; end_at timestamptz; intended_date date; resolved_date date;
 offset_minutes integer; resolved_local timestamp; intended_local timestamp;
BEGIN
 SELECT * INTO h FROM public.recurrence_instances WHERE workspace_id=target_workspace AND id=target_instance;
 IF NOT FOUND THEN RETURN; END IF;
 SELECT * INTO v FROM public.recurrence_series_versions WHERE workspace_id=h.workspace_id AND project_id=h.project_id AND series_id=h.series_id AND id=h.source_version_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Recurrence header source version must belong to its series' USING ERRCODE='check_violation'; END IF;
 SELECT max(revision) INTO latest FROM public.recurrence_exception_versions WHERE workspace_id=h.workspace_id AND instance_id=h.id;
 IF h.exception_version_id IS NULL THEN
  IF latest IS NOT NULL THEN RAISE EXCEPTION 'Recurrence header must point to its latest exception' USING ERRCODE='check_violation'; END IF;
 ELSE
  SELECT * INTO e FROM public.recurrence_exception_versions WHERE workspace_id=h.workspace_id AND project_id=h.project_id AND instance_id=h.id AND id=h.exception_version_id;
  IF NOT FOUND OR e.revision<>latest THEN RAISE EXCEPTION 'Recurrence header must point to its latest exception' USING ERRCODE='check_violation'; END IF;
  head_kind:=e.kind::text;
 END IF;
 IF (head_kind='skip' AND h.calendar_state<>'cancelled') OR (head_kind='move' AND h.calendar_state<>'scheduled') THEN RAISE EXCEPTION 'Recurrence calendar state must follow its exception head' USING ERRCODE='check_violation'; END IF;
 IF v.schedule#>>'{end,kind}'='after_count' THEN
  IF h.nominal_sequence IS NULL OR h.nominal_sequence>(v.schedule#>>'{end,count}')::numeric THEN RAISE EXCEPTION 'after_count header needs its original sequence position' USING ERRCODE='check_violation'; END IF;
 ELSIF h.nominal_sequence IS NOT NULL THEN RAISE EXCEPTION 'on_date header has no sequence position' USING ERRCODE='check_violation';
 END IF;
 IF h.occurrence_key<public.workloom_recurrence_date(v.schedule->>'startDate') THEN RAISE EXCEPTION 'Recurrence key precedes the series start' USING ERRCODE='check_violation'; END IF;
 r:=h.resolution;
 start_at:=public.workloom_recurrence_instant(r->>'resolvedStartAt');
 end_at:=public.workloom_recurrence_instant(r->>'resolvedEndAt');
 intended_date:=public.workloom_recurrence_date(r->>'intendedLocalDate');
 resolved_date:=public.workloom_recurrence_date(r->>'resolvedLocalDate');
 IF start_at IS NULL OR end_at IS NULL OR intended_date IS NULL OR resolved_date IS NULL THEN RAISE EXCEPTION 'Recurrence resolution needs exact ISO instants and real supported local dates' USING ERRCODE='check_violation'; END IF;
 IF mod(extract(epoch FROM start_at)::numeric,60)<>0 THEN RAISE EXCEPTION 'Recurrence resolved start must be minute-exact' USING ERRCODE='check_violation'; END IF;
 IF end_at<>start_at+make_interval(mins=>(r->>'plannedDurationMinutes')::numeric::integer) THEN RAISE EXCEPTION 'Recurrence resolved end must equal start plus elapsed duration' USING ERRCODE='check_violation'; END IF;
 offset_minutes:=(CASE WHEN left(r->>'resolvedOffset',1)='-' THEN -1 ELSE 1 END)*(substr(r->>'resolvedOffset',2,2)::integer*60+substr(r->>'resolvedOffset',5,2)::integer);
 resolved_local:=(start_at AT TIME ZONE 'UTC')+make_interval(mins=>offset_minutes);
 IF resolved_local<>resolved_date+(r->>'resolvedLocalTime')::time THEN RAISE EXCEPTION 'Recurrence resolved wall time must equal start plus offset' USING ERRCODE='check_violation'; END IF;
 intended_local:=intended_date+(r->>'intendedLocalTime')::time;
 IF (CASE COALESCE(r->>'warning','none') WHEN 'gap_first_valid' THEN resolved_local<=intended_local WHEN 'skipped_local_date' THEN resolved_date<=intended_date ELSE resolved_local<>intended_local END) THEN
  RAISE EXCEPTION 'Recurrence resolution warning must match intended and resolved wall times' USING ERRCODE='check_violation';
 END IF;
 IF h.calendar_state='scheduled' THEN
  IF r#>>'{provenance,timezone}'<>v.schedule->>'timezone' OR (r->>'plannedDurationMinutes')::numeric<>(v.schedule->>'plannedDurationMinutes')::numeric THEN RAISE EXCEPTION 'Scheduled resolution must use its source version zone and duration' USING ERRCODE='check_violation'; END IF;
  IF head_kind='move' THEN
   IF intended_date<>e.local_date OR r->>'intendedLocalTime'<>e.local_time THEN RAISE EXCEPTION 'Moved header must intend the move date and time' USING ERRCODE='check_violation'; END IF;
  ELSIF intended_date<>h.occurrence_key OR r->>'intendedLocalTime'<>v.schedule->>'localTime' THEN
   RAISE EXCEPTION 'Scheduled header must intend its nominal key at the version local time' USING ERRCODE='check_violation';
  END IF;
  IF head_kind IN ('none','reset') THEN
   IF v.effective_from_nominal_date>h.occurrence_key OR EXISTS(SELECT 1 FROM public.recurrence_series_versions w WHERE w.workspace_id=h.workspace_id AND w.series_id=h.series_id AND w.effective_from_nominal_date<=h.occurrence_key AND w.revision>v.revision) THEN
    RAISE EXCEPTION 'Scheduled header must use the highest-revision version effective at its key' USING ERRCODE='check_violation';
   END IF;
   IF v.schedule->>'frequency'='weekly' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v.schedule->'weekdays') w WHERE w=to_jsonb(extract(isodow FROM h.occurrence_key)::integer)) THEN RAISE EXCEPTION 'Scheduled key is not a version weekday' USING ERRCODE='check_violation'; END IF;
   IF v.schedule#>>'{end,kind}'='on_date' AND h.occurrence_key>public.workloom_recurrence_date(v.schedule#>>'{end,endDate}') THEN RAISE EXCEPTION 'Scheduled key is after the version end date' USING ERRCODE='check_violation'; END IF;
  END IF;
 END IF;
END; $$;
--> statement-breakpoint
-- Dispatches deferred coherence: header writes, exception inserts, and version inserts (every header of the series
-- at/after the new boundary must already follow the latest write in the same transaction).
CREATE FUNCTION public.workloom_check_recurrence_census() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE header_id uuid;
BEGIN
 IF TG_TABLE_NAME='recurrence_instances' THEN
  PERFORM public.workloom_recurrence_assert_instance(NEW.workspace_id,NEW.id);
 ELSIF TG_TABLE_NAME='recurrence_exception_versions' THEN
  PERFORM public.workloom_recurrence_assert_instance(NEW.workspace_id,NEW.instance_id);
 ELSE
  FOR header_id IN SELECT id FROM public.recurrence_instances WHERE workspace_id=NEW.workspace_id AND series_id=NEW.series_id AND occurrence_key>=NEW.effective_from_nominal_date LOOP
   PERFORM public.workloom_recurrence_assert_instance(NEW.workspace_id,header_id);
  END LOOP;
 END IF;
 RETURN NULL;
END; $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER recurrence_instances_census_check AFTER INSERT OR UPDATE ON public.recurrence_instances DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.workloom_check_recurrence_census();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER recurrence_exception_versions_census_check AFTER INSERT ON public.recurrence_exception_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.workloom_check_recurrence_census();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER recurrence_series_versions_census_check AFTER INSERT ON public.recurrence_series_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.workloom_check_recurrence_census();
--> statement-breakpoint
-- Exception versions: strictly increasing revision per header.
CREATE FUNCTION public.workloom_check_recurrence_exception() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE latest integer;
BEGIN
 SELECT max(revision) INTO latest FROM public.recurrence_exception_versions WHERE workspace_id=NEW.workspace_id AND instance_id=NEW.instance_id AND id<>NEW.id;
 IF latest IS NOT NULL AND NEW.revision<=latest THEN RAISE EXCEPTION 'Recurrence exception revision must increase' USING ERRCODE='check_violation'; END IF;
 RETURN NULL;
END; $$;
--> statement-breakpoint
CREATE TRIGGER recurrence_exception_versions_validity AFTER INSERT ON public.recurrence_exception_versions FOR EACH ROW EXECUTE FUNCTION public.workloom_check_recurrence_exception();
--> statement-breakpoint
-- Calendar locks: the baseline belongs to the header period and its optional recurrence census contains this exact
-- header identity, state, resolution and locators (JSON null for a cancelled never-materialized header).
CREATE FUNCTION public.workloom_check_recurrence_calendar_lock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h public.recurrence_instances%ROWTYPE; b public.plan_baselines%ROWTYPE; census jsonb; entry jsonb;
BEGIN
 SELECT * INTO h FROM public.recurrence_instances WHERE workspace_id=NEW.workspace_id AND project_id=NEW.project_id AND id=NEW.instance_id;
 SELECT * INTO b FROM public.plan_baselines WHERE workspace_id=NEW.workspace_id AND project_id=NEW.project_id AND id=NEW.baseline_id;
 IF h.id IS NULL OR b.id IS NULL OR b.period_id<>h.period_id THEN RAISE EXCEPTION 'Calendar lock must pair a header with a baseline of its period' USING ERRCODE='check_violation'; END IF;
 IF NEW.meeting_id IS DISTINCT FROM h.meeting_id THEN RAISE EXCEPTION 'Calendar lock meeting must match the header locator' USING ERRCODE='check_violation'; END IF;
 census:=b.snapshot#>'{recurrence,census}';
 IF jsonb_typeof(census) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Calendar lock baseline has no recurrence census' USING ERRCODE='check_violation'; END IF;
 SELECT c INTO entry FROM jsonb_array_elements(census) c WHERE jsonb_typeof(c)='object' AND c->>'instanceId'=h.id::text LIMIT 1;
 IF entry IS NULL
  OR (entry->>'seriesId',entry->>'bindingId',entry->>'occurrenceKey',entry->>'sourceVersionId',entry->>'exceptionVersionId',entry->>'calendarState',entry->>'meetingId',entry->>'taskId',entry->>'workPackageId')
   IS DISTINCT FROM (h.series_id::text,h.binding_id::text,to_char(h.occurrence_key,'YYYY-MM-DD'),h.source_version_id::text,h.exception_version_id::text,h.calendar_state::text,h.meeting_id::text,h.task_id::text,h.work_package_id::text)
  OR (entry->'nominalSequence') IS DISTINCT FROM COALESCE(to_jsonb(h.nominal_sequence),'null'::jsonb)
  OR (entry->'resolution') IS DISTINCT FROM h.resolution THEN
  RAISE EXCEPTION 'Calendar lock must match the baseline recurrence census entry' USING ERRCODE='check_violation';
 END IF;
 RETURN NULL;
END; $$;
--> statement-breakpoint
CREATE TRIGGER recurrence_calendar_locks_validity AFTER INSERT ON public.recurrence_calendar_locks FOR EACH ROW EXECUTE FUNCTION public.workloom_check_recurrence_calendar_lock();
--> statement-breakpoint
-- Append-only history (UPDATE/DELETE/TRUNCATE -> 42501).
CREATE TRIGGER recurrence_series_versions_immutable_rows BEFORE UPDATE OR DELETE ON public.recurrence_series_versions FOR EACH ROW EXECUTE FUNCTION public.workloom_reject_recurrence_mutation();
--> statement-breakpoint
CREATE TRIGGER recurrence_series_versions_immutable_truncate BEFORE TRUNCATE ON public.recurrence_series_versions FOR EACH STATEMENT EXECUTE FUNCTION public.workloom_reject_recurrence_mutation();
--> statement-breakpoint
CREATE TRIGGER recurrence_generation_authorizations_immutable_rows BEFORE UPDATE OR DELETE ON public.recurrence_generation_authorizations FOR EACH ROW EXECUTE FUNCTION public.workloom_reject_recurrence_mutation();
--> statement-breakpoint
CREATE TRIGGER recurrence_generation_authorizations_immutable_truncate BEFORE TRUNCATE ON public.recurrence_generation_authorizations FOR EACH STATEMENT EXECUTE FUNCTION public.workloom_reject_recurrence_mutation();
--> statement-breakpoint
CREATE TRIGGER recurrence_exception_versions_immutable_rows BEFORE UPDATE OR DELETE ON public.recurrence_exception_versions FOR EACH ROW EXECUTE FUNCTION public.workloom_reject_recurrence_mutation();
--> statement-breakpoint
CREATE TRIGGER recurrence_exception_versions_immutable_truncate BEFORE TRUNCATE ON public.recurrence_exception_versions FOR EACH STATEMENT EXECUTE FUNCTION public.workloom_reject_recurrence_mutation();
--> statement-breakpoint
CREATE TRIGGER recurrence_calendar_locks_immutable_rows BEFORE UPDATE OR DELETE ON public.recurrence_calendar_locks FOR EACH ROW EXECUTE FUNCTION public.workloom_reject_recurrence_mutation();
--> statement-breakpoint
CREATE TRIGGER recurrence_calendar_locks_immutable_truncate BEFORE TRUNCATE ON public.recurrence_calendar_locks FOR EACH STATEMENT EXECUTE FUNCTION public.workloom_reject_recurrence_mutation();
--> statement-breakpoint
-- Heads are updated in place but never erased: series, bindings and stable census headers reject DELETE/TRUNCATE.
CREATE TRIGGER recurrence_series_no_erase_rows BEFORE DELETE ON public.recurrence_series FOR EACH ROW EXECUTE FUNCTION public.workloom_reject_recurrence_mutation();
--> statement-breakpoint
CREATE TRIGGER recurrence_series_no_erase_truncate BEFORE TRUNCATE ON public.recurrence_series FOR EACH STATEMENT EXECUTE FUNCTION public.workloom_reject_recurrence_mutation();
--> statement-breakpoint
CREATE TRIGGER recurrence_period_bindings_no_erase_rows BEFORE DELETE ON public.recurrence_period_bindings FOR EACH ROW EXECUTE FUNCTION public.workloom_reject_recurrence_mutation();
--> statement-breakpoint
CREATE TRIGGER recurrence_period_bindings_no_erase_truncate BEFORE TRUNCATE ON public.recurrence_period_bindings FOR EACH STATEMENT EXECUTE FUNCTION public.workloom_reject_recurrence_mutation();
--> statement-breakpoint
CREATE TRIGGER recurrence_instances_no_erase_rows BEFORE DELETE ON public.recurrence_instances FOR EACH ROW EXECUTE FUNCTION public.workloom_reject_recurrence_mutation();
--> statement-breakpoint
CREATE TRIGGER recurrence_instances_no_erase_truncate BEFORE TRUNCATE ON public.recurrence_instances FOR EACH STATEMENT EXECUTE FUNCTION public.workloom_reject_recurrence_mutation();