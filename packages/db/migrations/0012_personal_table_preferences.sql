CREATE FUNCTION "public"."workloom_valid_personal_table_columns"(choices jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE
  choice jsonb;
  ref jsonb;
  ref_key text;
  seen text[] := ARRAY[]::text[];
  custom_count integer := 0;
BEGIN
  IF jsonb_typeof(choices) <> 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(choices) NOT BETWEEN 1 AND 210 THEN RETURN false; END IF;
  IF choices->0 <> '{"column":{"kind":"builtin","key":"title"},"visible":true}'::jsonb THEN RETURN false; END IF;
  FOR choice IN SELECT value FROM jsonb_array_elements(choices) LOOP
    IF jsonb_typeof(choice) <> 'object' THEN RETURN false; END IF;
    IF NOT (choice ?& ARRAY['column','visible']) OR choice - 'column' - 'visible' <> '{}'::jsonb THEN RETURN false; END IF;
    IF jsonb_typeof(choice->'visible') IS DISTINCT FROM 'boolean' THEN RETURN false; END IF;
    ref := choice->'column';
    IF jsonb_typeof(ref) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
    IF ref->>'kind' = 'builtin' THEN
      IF ref - 'kind' - 'key' <> '{}'::jsonb OR jsonb_typeof(ref->'key') IS DISTINCT FROM 'string' THEN RETURN false; END IF;
      IF ref->>'key' NOT IN ('title','status','responsible','participants','dueDate','tags','priority','estimate','weeklyPlan','weeklyActual') THEN RETURN false; END IF;
      ref_key := 'builtin:' || (ref->>'key');
    ELSIF ref->>'kind' = 'field' THEN
      IF ref - 'kind' - 'fieldId' <> '{}'::jsonb OR jsonb_typeof(ref->'fieldId') IS DISTINCT FROM 'string' THEN RETURN false; END IF;
      IF ref->>'fieldId' !~ '^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$' THEN RETURN false; END IF;
      ref_key := 'field:' || (ref->>'fieldId');
      custom_count := custom_count + 1;
      IF custom_count > 200 THEN RETURN false; END IF;
    ELSE RETURN false;
    END IF;
    IF ref_key = ANY(seen) THEN RETURN false; END IF;
    seen := array_append(seen, ref_key);
  END LOOP;
  RETURN true;
END;
$$;
--> statement-breakpoint
CREATE TABLE "personal_table_preferences" (
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"columns" jsonb,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "personal_table_preferences_pk" PRIMARY KEY("workspace_id","project_id","membership_id"),
	CONSTRAINT "personal_table_preferences_revision" CHECK (revision >= 1),
	CONSTRAINT "personal_table_preferences_time" CHECK (isfinite(updated_at)),
	CONSTRAINT "personal_table_preferences_columns" CHECK (columns is null or public.workloom_valid_personal_table_columns(columns))
);
--> statement-breakpoint
ALTER TABLE "personal_table_preferences" ADD CONSTRAINT "personal_table_preferences_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_table_preferences" ADD CONSTRAINT "personal_table_preferences_membership_fk" FOREIGN KEY ("workspace_id","membership_id") REFERENCES "public"."memberships"("workspace_id","id") ON DELETE no action ON UPDATE no action;
