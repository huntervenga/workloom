CREATE TABLE "external_import_references" (
	"workspace_id" uuid NOT NULL,
	"source_namespace" text NOT NULL,
	"external_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"import_id" uuid NOT NULL,
	"source_digest" text NOT NULL,
	"owned_revisions" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "external_import_references_workspace_id_source_namespace_external_id_pk" PRIMARY KEY("workspace_id","source_namespace","external_id"),
	CONSTRAINT "external_import_references_shape_check" CHECK (char_length("external_import_references"."source_namespace") BETWEEN 1 AND 160 AND char_length("external_import_references"."external_id") BETWEEN 1 AND 254 AND "external_import_references"."source_digest" ~ '^[a-f0-9]{64}$' AND jsonb_typeof("external_import_references"."owned_revisions")='object' AND ("external_import_references"."owned_revisions" ?& ARRAY['taskRevision','participantsRevision','workPackageRevision','fields']) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "project_imports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"source_namespace" text NOT NULL,
	"file_name" text NOT NULL,
	"file_digest" text NOT NULL,
	"raw_csv" text NOT NULL,
	"revision" integer NOT NULL,
	"status" text NOT NULL,
	"headers" jsonb NOT NULL,
	"source_rows" jsonb NOT NULL,
	"reconciliation" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"applied_at" timestamp with time zone,
	CONSTRAINT "project_imports_scope_unique" UNIQUE("workspace_id","project_id","id"),
	CONSTRAINT "project_imports_namespace_scope_unique" UNIQUE("workspace_id","project_id","id","source_namespace"),
	CONSTRAINT "project_imports_limits_check" CHECK (char_length("project_imports"."source_namespace") BETWEEN 1 AND 160 AND char_length("project_imports"."file_name") BETWEEN 1 AND 255 AND "project_imports"."file_digest" ~ '^[a-f0-9]{64}$' AND octet_length("project_imports"."raw_csv") <= 1048576 AND CASE WHEN jsonb_typeof("project_imports"."headers")='array' THEN jsonb_array_length("project_imports"."headers") BETWEEN 1 AND 100 ELSE false END AND CASE WHEN jsonb_typeof("project_imports"."source_rows")='array' THEN jsonb_array_length("project_imports"."source_rows") BETWEEN 1 AND 50 ELSE false END),
	CONSTRAINT "project_imports_state_check" CHECK ((("project_imports"."status"='staged' AND "project_imports"."revision"=1 AND "project_imports"."applied_at" IS NULL AND "project_imports"."reconciliation" IS NULL) OR ("project_imports"."status"='applied' AND "project_imports"."revision"=2 AND "project_imports"."applied_at" IS NOT NULL AND ("project_imports"."reconciliation"->>'status'='applied') IS TRUE)))
);
--> statement-breakpoint
ALTER TABLE "external_import_references" ADD CONSTRAINT "external_import_references_task_fk" FOREIGN KEY ("workspace_id","project_id","task_id") REFERENCES "public"."tasks"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_import_references" ADD CONSTRAINT "external_import_references_import_fk" FOREIGN KEY ("workspace_id","project_id","import_id","source_namespace") REFERENCES "public"."project_imports"("workspace_id","project_id","id","source_namespace") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_imports" ADD CONSTRAINT "project_imports_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- Applied artifacts preserve exact original source and approved mapping; only one staged→applied transition exists.
CREATE FUNCTION workloom_import_artifact_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN IF NEW.status<>'staged' OR NEW.revision<>1 OR NEW.reconciliation IS NOT NULL OR NEW.applied_at IS NOT NULL THEN RAISE EXCEPTION 'Import starts as an inert staged artifact' USING ERRCODE='23514'; END IF; RETURN NEW; END IF;
 IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Import artifacts are retained' USING ERRCODE='42501'; END IF;
 IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
 IF OLD.status<>'staged' OR NEW.status<>'applied' OR NEW.revision<>OLD.revision+1 OR
   (to_jsonb(NEW)-ARRAY['status','revision','applied_at','reconciliation']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','revision','applied_at','reconciliation'])
 THEN RAISE EXCEPTION 'Import artifact source/identity is immutable; only staged to applied is permitted' USING ERRCODE='23514'; END IF;
 IF NOT ((jsonb_typeof(NEW.reconciliation)='object' AND NEW.reconciliation->>'status'='applied' AND NEW.reconciliation->>'importId'=NEW.id::text AND NEW.reconciliation->>'projectId'=NEW.project_id::text AND NEW.reconciliation->>'sourceDigest'=NEW.file_digest AND NEW.reconciliation->>'mappingHash' ~ '^[a-f0-9]{64}$' AND jsonb_typeof(NEW.reconciliation->'mapping')='object' AND jsonb_typeof(NEW.reconciliation->'rows')='array') IS TRUE)
 THEN RAISE EXCEPTION 'Invalid import reconciliation identity or mapping' USING ERRCODE='23514'; END IF;
 IF jsonb_array_length(NEW.reconciliation->'rows')<>jsonb_array_length(NEW.source_rows) OR EXISTS (
  SELECT 1 FROM jsonb_array_elements(NEW.reconciliation->'rows') AS entry WHERE NOT EXISTS (
   SELECT 1 FROM external_import_references r WHERE r.workspace_id=NEW.workspace_id AND r.project_id=NEW.project_id AND r.source_namespace=NEW.source_namespace AND r.external_id=entry->>'externalId' AND r.task_id::text=entry->>'targetTaskId'))
 THEN RAISE EXCEPTION 'Every source row must reconcile to a scoped stable mapping' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER project_imports_identity_guard BEFORE INSERT OR UPDATE OR DELETE ON project_imports FOR EACH ROW EXECUTE FUNCTION workloom_import_artifact_guard();
--> statement-breakpoint
CREATE TRIGGER project_imports_truncate_guard BEFORE TRUNCATE ON project_imports FOR EACH STATEMENT EXECUTE FUNCTION workloom_import_artifact_guard();
--> statement-breakpoint
CREATE TRIGGER external_import_references_immutable_rows BEFORE UPDATE OR DELETE ON external_import_references FOR EACH ROW EXECUTE FUNCTION workloom_reject_planning_history_mutation();
--> statement-breakpoint
CREATE TRIGGER external_import_references_immutable_truncate BEFORE TRUNCATE ON external_import_references FOR EACH STATEMENT EXECUTE FUNCTION workloom_reject_planning_history_mutation();
--> statement-breakpoint
-- Explicit IS TRUE prevents SQL UNKNOWN from accepting missing discriminator/revision keys.
CREATE FUNCTION workloom_import_vector_valid(v jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE entry jsonb;
BEGIN
 IF NOT ((jsonb_typeof(v)='object' AND v ?& ARRAY['taskRevision','participantsRevision','workPackageRevision','fields'] AND jsonb_typeof(v->'fields')='array' AND jsonb_typeof(v->'taskRevision')='number' AND jsonb_typeof(v->'participantsRevision')='number' AND jsonb_typeof(v->'workPackageRevision')='number' AND (v->>'taskRevision') ~ '^[1-9][0-9]*$' AND (v->>'participantsRevision') ~ '^[1-9][0-9]*$' AND (v->>'workPackageRevision') ~ '^[1-9][0-9]*$') IS TRUE) THEN RETURN false; END IF;
 IF jsonb_array_length(v->'fields')>20 THEN RETURN false; END IF;
 FOR entry IN SELECT value FROM jsonb_array_elements(v->'fields') LOOP
  IF NOT ((jsonb_typeof(entry)='object' AND entry ?& ARRAY['fieldId','definitionRevision','valueRevision'] AND jsonb_typeof(entry->'definitionRevision')='number' AND jsonb_typeof(entry->'valueRevision')='number' AND (entry->>'fieldId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AND (entry->>'definitionRevision') ~ '^[1-9][0-9]*$' AND (entry->>'valueRevision') ~ '^(0|[1-9][0-9]*)$') IS TRUE) THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END $$;
--> statement-breakpoint
ALTER TABLE external_import_references ADD CONSTRAINT external_import_references_vector_check CHECK (workloom_import_vector_valid(owned_revisions));
