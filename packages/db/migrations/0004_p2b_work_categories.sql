CREATE TABLE "project_work_category_binding_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"field_id" uuid,
	"actor_user_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"change_seq" bigint NOT NULL,
	CONSTRAINT "project_work_category_binding_versions_scope_unique" UNIQUE("workspace_id","project_id","id"),
	CONSTRAINT "project_work_category_binding_versions_head_unique" UNIQUE("workspace_id","project_id","id","revision"),
	CONSTRAINT "project_work_category_binding_versions_revision_unique" UNIQUE("workspace_id","project_id","revision"),
	CONSTRAINT "project_work_category_binding_versions_values" CHECK (revision >= 2 and change_seq >= 1)
);
--> statement-breakpoint
CREATE TABLE "project_work_category_bindings" (
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"version_id" uuid NOT NULL,
	"field_id" uuid,
	CONSTRAINT "project_work_category_bindings_pk" PRIMARY KEY("workspace_id","project_id"),
	CONSTRAINT "project_work_category_bindings_revision" CHECK (revision >= 2)
);
--> statement-breakpoint
CREATE TABLE "work_type_report_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"document" jsonb NOT NULL,
	"rows" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "work_type_report_runs_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "work_type_report_runs_document_identity" CHECK ((jsonb_typeof(document) = 'object' and document->>'id' = id::text and document->>'workspaceId' = workspace_id::text and document->>'projectId' = project_id::text and document->>'periodId' = period_id::text and document->>'metricVersion' = 'weekly_work_type_v1' and jsonb_typeof(rows) = 'array' and jsonb_array_length(rows) = (document->>'rowCount')::integer and jsonb_typeof(document->'workLogRevisionIds') = 'array' and jsonb_array_length(document->'workLogRevisionIds') = jsonb_array_length(rows)) is true)
);
--> statement-breakpoint
ALTER TABLE "work_log_revisions" ADD COLUMN "category" jsonb;--> statement-breakpoint
ALTER TABLE "work_log_revisions" ADD COLUMN "category_project_id" uuid;--> statement-breakpoint
ALTER TABLE "work_log_revisions" ADD COLUMN "category_binding_version_id" uuid;--> statement-breakpoint
ALTER TABLE "work_log_revisions" ADD COLUMN "category_binding_revision" integer;--> statement-breakpoint
ALTER TABLE "work_log_revisions" ADD COLUMN "category_field_id" uuid;--> statement-breakpoint
ALTER TABLE "work_log_revisions" ADD COLUMN "category_definition_version_id" uuid;--> statement-breakpoint
ALTER TABLE "work_log_revisions" ADD COLUMN "category_option_id" uuid;--> statement-breakpoint
ALTER TABLE "work_log_revisions" ADD COLUMN "category_option_revision" integer;--> statement-breakpoint
ALTER TABLE "project_work_category_binding_versions" ADD CONSTRAINT "project_work_category_binding_versions_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_work_category_binding_versions" ADD CONSTRAINT "project_work_category_binding_versions_field_fk" FOREIGN KEY ("workspace_id","project_id","field_id") REFERENCES "public"."task_field_definitions"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_work_category_binding_versions" ADD CONSTRAINT "project_work_category_binding_versions_actor_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_work_category_bindings" ADD CONSTRAINT "project_work_category_bindings_version_fk" FOREIGN KEY ("workspace_id","project_id","version_id","revision") REFERENCES "public"."project_work_category_binding_versions"("workspace_id","project_id","id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_work_category_bindings" ADD CONSTRAINT "project_work_category_bindings_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_work_category_bindings" ADD CONSTRAINT "project_work_category_bindings_field_fk" FOREIGN KEY ("workspace_id","project_id","field_id") REFERENCES "public"."task_field_definitions"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_type_report_runs" ADD CONSTRAINT "work_type_report_runs_period_fk" FOREIGN KEY ("workspace_id","project_id","period_id") REFERENCES "public"."planning_periods"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_logs" ADD CONSTRAINT "work_logs_project_id_unique" UNIQUE("workspace_id","id","project_id");--> statement-breakpoint
ALTER TABLE "work_log_revisions" ADD CONSTRAINT "work_log_revisions_category_source_project_fk" FOREIGN KEY ("workspace_id","work_log_id","category_project_id") REFERENCES "public"."work_logs"("workspace_id","id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_log_revisions" ADD CONSTRAINT "work_log_revisions_category_binding_fk" FOREIGN KEY ("workspace_id","category_project_id","category_binding_version_id") REFERENCES "public"."project_work_category_binding_versions"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_log_revisions" ADD CONSTRAINT "work_log_revisions_category_field_fk" FOREIGN KEY ("workspace_id","category_project_id","category_field_id") REFERENCES "public"."task_field_definitions"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_log_revisions" ADD CONSTRAINT "work_log_revisions_category_definition_fk" FOREIGN KEY ("workspace_id","category_project_id","category_field_id","category_definition_version_id") REFERENCES "public"."task_field_definition_versions"("workspace_id","project_id","field_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_log_revisions" ADD CONSTRAINT "work_log_revisions_category_option_fk" FOREIGN KEY ("workspace_id","category_project_id","category_field_id","category_option_id") REFERENCES "public"."task_field_options"("workspace_id","project_id","field_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_log_revisions" ADD CONSTRAINT "work_log_revisions_category_snapshot" CHECK ((
    (category is null and category_project_id is null and category_binding_version_id is null and category_binding_revision is null and category_field_id is null and category_definition_version_id is null and category_option_id is null and category_option_revision is null)
    or (category is not null and category_project_id is not null and (category_binding_revision is null or category_binding_revision >= 1) and jsonb_typeof(category) = 'object' and (
      (category->>'kind' = 'categorized' and category ?& array['bindingVersionId','bindingRevision','fieldId','fieldDefinitionVersionId','fieldLabel','optionId','optionRevision','optionLabel','color','optionArchivedAt']
       and category_binding_version_id is not null and category_binding_revision >= 2 and category_field_id is not null and category_definition_version_id is not null and category_option_id is not null and category_option_revision >= 1
       and category->>'bindingVersionId' = category_binding_version_id::text and category->>'bindingRevision' = category_binding_revision::text and category->>'fieldId' = category_field_id::text and category->>'fieldDefinitionVersionId' = category_definition_version_id::text and category->>'optionId' = category_option_id::text and category->>'optionRevision' = category_option_revision::text
       and jsonb_typeof(category->'fieldLabel') = 'string' and jsonb_typeof(category->'optionLabel') = 'string')
      or (category->>'kind' = 'uncategorized' and category ?& array['reason','bindingVersionId','bindingRevision','fieldId'] and category->>'reason' in ('legacy','unbound','field_unavailable','unset','explicit_clear')
       and (category->>'bindingVersionId') is not distinct from category_binding_version_id::text and (category->>'bindingRevision') is not distinct from category_binding_revision::text and (category->>'fieldId') is not distinct from category_field_id::text
       and category_definition_version_id is null and category_option_id is null and category_option_revision is null)
    ))) is true);--> statement-breakpoint
-- Category history reuses the applied append-only guard; old revisions are never backfilled.
CREATE TRIGGER project_work_category_binding_versions_immutable_rows BEFORE UPDATE OR DELETE ON public.project_work_category_binding_versions FOR EACH ROW EXECUTE FUNCTION public.workloom_reject_planning_history_mutation();
--> statement-breakpoint
CREATE TRIGGER project_work_category_binding_versions_immutable_truncate BEFORE TRUNCATE ON public.project_work_category_binding_versions FOR EACH STATEMENT EXECUTE FUNCTION public.workloom_reject_planning_history_mutation();
--> statement-breakpoint
CREATE TRIGGER work_type_report_runs_immutable_rows BEFORE UPDATE OR DELETE ON public.work_type_report_runs FOR EACH ROW EXECUTE FUNCTION public.workloom_reject_planning_history_mutation();
--> statement-breakpoint
CREATE TRIGGER work_type_report_runs_immutable_truncate BEFORE TRUNCATE ON public.work_type_report_runs FOR EACH STATEMENT EXECUTE FUNCTION public.workloom_reject_planning_history_mutation();
--> statement-breakpoint
CREATE FUNCTION public.workloom_check_work_category_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE version_row public.project_work_category_binding_versions%ROWTYPE; field_type text;
BEGIN
  IF TG_TABLE_NAME = 'project_work_category_binding_versions' THEN
    IF NEW.field_id IS NOT NULL THEN
      SELECT type::text INTO field_type FROM public.task_field_definitions WHERE workspace_id=NEW.workspace_id AND project_id=NEW.project_id AND id=NEW.field_id;
      IF FOUND AND field_type <> 'single_select' THEN RAISE EXCEPTION 'Work category field must be single-select' USING ERRCODE='check_violation'; END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='INSERT' AND NEW.revision<>2 THEN RAISE EXCEPTION 'First binding revision must be two' USING ERRCODE='check_violation'; END IF;
  IF TG_OP='UPDATE' THEN
    IF (NEW.workspace_id,NEW.project_id) IS DISTINCT FROM (OLD.workspace_id,OLD.project_id) OR NEW.revision<>OLD.revision+1 THEN
      RAISE EXCEPTION 'Binding identity is immutable and revision advances once' USING ERRCODE='check_violation';
    END IF;
  END IF;
  SELECT * INTO version_row FROM public.project_work_category_binding_versions WHERE workspace_id=NEW.workspace_id AND project_id=NEW.project_id AND id=NEW.version_id;
  IF FOUND AND (version_row.revision,version_row.field_id) IS DISTINCT FROM (NEW.revision,NEW.field_id) THEN
    RAISE EXCEPTION 'Binding head must match immutable version' USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER project_work_category_binding_versions_type_guard BEFORE INSERT ON public.project_work_category_binding_versions FOR EACH ROW EXECUTE FUNCTION public.workloom_check_work_category_binding();
--> statement-breakpoint
CREATE TRIGGER project_work_category_bindings_head_guard BEFORE INSERT OR UPDATE ON public.project_work_category_bindings FOR EACH ROW EXECUTE FUNCTION public.workloom_check_work_category_binding();
--> statement-breakpoint
CREATE FUNCTION public.workloom_check_work_revision_category() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE binding_row public.project_work_category_binding_versions%ROWTYPE; definition_snapshot jsonb; option_snapshot jsonb;
BEGIN
  IF NEW.category IS NULL THEN RETURN NEW; END IF;
  IF NEW.category_binding_version_id IS NOT NULL THEN
    SELECT * INTO binding_row FROM public.project_work_category_binding_versions WHERE workspace_id=NEW.workspace_id AND project_id=NEW.category_project_id AND id=NEW.category_binding_version_id;
    IF FOUND AND (binding_row.revision,binding_row.field_id) IS DISTINCT FROM (NEW.category_binding_revision,NEW.category_field_id) THEN
      RAISE EXCEPTION 'Category binding provenance does not match its immutable version' USING ERRCODE='check_violation';
    END IF;
  END IF;
  IF NEW.category->>'kind'='uncategorized' THEN
    IF (NEW.category->>'reason'='legacy' AND (NEW.category_binding_version_id IS NOT NULL OR NEW.category_binding_revision IS NOT NULL OR NEW.category_field_id IS NOT NULL))
      OR (NEW.category->>'reason'='unbound' AND NEW.category_field_id IS NOT NULL)
      OR (NEW.category->>'reason' IN ('field_unavailable','unset') AND (NEW.category_binding_version_id IS NULL OR NEW.category_field_id IS NULL)) THEN
      RAISE EXCEPTION 'Uncategorized provenance has an invalid reference shape' USING ERRCODE='check_violation';
    END IF;
    RETURN NEW;
  END IF;
  SELECT snapshot INTO definition_snapshot FROM public.task_field_definition_versions WHERE workspace_id=NEW.workspace_id AND project_id=NEW.category_project_id AND field_id=NEW.category_field_id AND id=NEW.category_definition_version_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT o INTO option_snapshot FROM jsonb_array_elements(definition_snapshot->'options') o WHERE o->>'id'=NEW.category_option_id::text;
  IF (definition_snapshot->>'type'='single_select' AND definition_snapshot->>'name'=NEW.category->>'fieldLabel'
    AND option_snapshot->'revision'=to_jsonb(NEW.category_option_revision) AND option_snapshot->>'name'=NEW.category->>'optionLabel'
    AND option_snapshot->'color'=NEW.category->'color' AND option_snapshot->'archivedAt'=NEW.category->'optionArchivedAt') IS NOT TRUE THEN
    RAISE EXCEPTION 'Category snapshot metadata must match immutable field/option version' USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER work_log_revisions_category_guard BEFORE INSERT ON public.work_log_revisions FOR EACH ROW EXECUTE FUNCTION public.workloom_check_work_revision_category();
--> statement-breakpoint
CREATE FUNCTION public.workloom_check_work_type_report_manifest() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item jsonb; pinned_ids jsonb; declared_ids jsonb; row_count integer; unique_count integer; source_row record;
BEGIN
  IF jsonb_typeof(NEW.rows) IS DISTINCT FROM 'array' OR jsonb_typeof(NEW.document->'workLogRevisionIds') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Report rows and revision manifest must be arrays' USING ERRCODE='check_violation';
  END IF;
  SELECT coalesce(jsonb_agg(r->>'id' ORDER BY r->>'id'),'[]'::jsonb),count(*),count(DISTINCT r->>'id') INTO pinned_ids,row_count,unique_count FROM jsonb_array_elements(NEW.rows) r;
  SELECT coalesce(jsonb_agg(v ORDER BY v),'[]'::jsonb) INTO declared_ids FROM jsonb_array_elements_text(NEW.document->'workLogRevisionIds') v;
  IF pinned_ids IS DISTINCT FROM declared_ids OR row_count<>unique_count THEN RAISE EXCEPTION 'Report revision manifest must match unique rows' USING ERRCODE='check_violation'; END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(NEW.rows) LOOP
    IF (jsonb_typeof(item)='object' AND item->>'id'=item#>>'{workLog,revisionId}' AND item#>>'{workLog,workspaceId}'=NEW.workspace_id::text AND item#>>'{workLog,projectId}'=NEW.project_id::text AND item#>>'{workLog,periodId}'=NEW.period_id::text) IS NOT TRUE THEN
      RAISE EXCEPTION 'Report row scope/identity mismatch' USING ERRCODE='check_violation';
    END IF;
    SELECT r.id,r.revision,r.minutes,r.state,l.id AS log_id,l.task_id,l.membership_id,l.work_package_id INTO source_row
      FROM public.work_log_revisions r JOIN public.work_logs l ON l.workspace_id=r.workspace_id AND l.id=r.work_log_id
      WHERE r.workspace_id=NEW.workspace_id AND r.id=(item->>'id')::uuid AND l.project_id=NEW.project_id AND l.period_id=NEW.period_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Report row revision is outside its scoped source' USING ERRCODE='foreign_key_violation'; END IF;
    IF (item#>>'{workLog,id}'=source_row.log_id::text AND item#>>'{workLog,taskId}'=source_row.task_id::text AND item#>>'{workLog,membershipId}'=source_row.membership_id::text AND item#>>'{workLog,workPackageId}'=source_row.work_package_id::text AND item#>>'{workLog,revision}'=source_row.revision::text AND item#>>'{workLog,minutes}'=source_row.minutes::text AND item#>>'{workLog,state}'=source_row.state::text AND item->'excluded'=to_jsonb(source_row.state='void')) IS NOT TRUE THEN
      RAISE EXCEPTION 'Report row must match its pinned source revision' USING ERRCODE='check_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER work_type_report_runs_manifest_guard BEFORE INSERT ON public.work_type_report_runs FOR EACH ROW EXECUTE FUNCTION public.workloom_check_work_type_report_manifest();
