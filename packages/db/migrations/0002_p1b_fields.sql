CREATE TYPE "public"."task_field_type" AS ENUM('text', 'number', 'duration', 'date', 'single_select', 'multi_select', 'person', 'boolean', 'url');--> statement-breakpoint
CREATE TABLE "project_column_settings" (
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	CONSTRAINT "project_column_settings_pk" PRIMARY KEY("workspace_id","project_id"),
	CONSTRAINT "project_column_settings_revision_positive" CHECK (revision >= 1)
);
--> statement-breakpoint
CREATE TABLE "project_columns" (
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"visible" boolean DEFAULT true NOT NULL,
	"width" integer NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "project_columns_pk" PRIMARY KEY("workspace_id","project_id","field_id"),
	CONSTRAINT "project_columns_workspace_project_position_unique" UNIQUE("workspace_id","project_id","position"),
	CONSTRAINT "project_columns_width_range" CHECK (width between 80 and 640),
	CONSTRAINT "project_columns_position_nonnegative" CHECK (position >= 0)
);
--> statement-breakpoint
CREATE TABLE "task_field_definition_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_field_definition_versions_workspace_project_field_id_unique" UNIQUE("workspace_id","project_id","field_id","id"),
	CONSTRAINT "task_field_definition_versions_field_revision_unique" UNIQUE("workspace_id","project_id","field_id","revision"),
	CONSTRAINT "task_field_definition_versions_revision_positive" CHECK (revision >= 1),
	CONSTRAINT "task_field_definition_versions_snapshot_identity" CHECK ((jsonb_typeof(snapshot) = 'object' and snapshot ->> 'id' = field_id::text and snapshot ->> 'workspaceId' = workspace_id::text and snapshot ->> 'projectId' = project_id::text and snapshot ->> 'definitionVersionId' = id::text and snapshot -> 'revision' = to_jsonb(revision)) is true)
);
--> statement-breakpoint
CREATE TABLE "task_field_definitions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" "task_field_type" NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"definition_version_id" uuid NOT NULL,
	"history_enabled" boolean DEFAULT true NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_field_definitions_workspace_project_id_unique" UNIQUE("workspace_id","project_id","id"),
	CONSTRAINT "task_field_definitions_workspace_project_id_type_unique" UNIQUE("workspace_id","project_id","id","type"),
	CONSTRAINT "task_field_definitions_name_length" CHECK (char_length(btrim(name)) between 1 and 160),
	CONSTRAINT "task_field_definitions_revision_positive" CHECK (revision >= 1)
);
--> statement-breakpoint
CREATE TABLE "task_field_options" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"position" integer NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "task_field_options_workspace_project_field_id_unique" UNIQUE("workspace_id","project_id","field_id","id"),
	CONSTRAINT "task_field_options_name_length" CHECK (char_length(btrim(name)) between 1 and 100),
	CONSTRAINT "task_field_options_color_hex" CHECK (color is null or color ~ '^#[0-9a-f]{6}$'),
	CONSTRAINT "task_field_options_position_nonnegative" CHECK (position >= 0),
	CONSTRAINT "task_field_options_revision_positive" CHECK (revision >= 1)
);
--> statement-breakpoint
CREATE TABLE "task_field_value_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"definition_version_id" uuid NOT NULL,
	"value_revision" integer NOT NULL,
	"before" jsonb,
	"after" jsonb NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"actor_display_name" text NOT NULL,
	"source" "command_source" NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"change_seq" bigint NOT NULL,
	"event_ordinal" integer NOT NULL,
	CONSTRAINT "task_field_value_history_workspace_seq_ordinal_unique" UNIQUE("workspace_id","change_seq","event_ordinal"),
	CONSTRAINT "task_field_value_history_value_revision_positive" CHECK (value_revision >= 1),
	CONSTRAINT "task_field_value_history_change_seq_positive" CHECK (change_seq >= 1),
	CONSTRAINT "task_field_value_history_event_ordinal_positive" CHECK (event_ordinal >= 1),
	CONSTRAINT "task_field_value_history_actor_display_name_length" CHECK (char_length(btrim(actor_display_name)) between 1 and 200),
	CONSTRAINT "task_field_value_history_after_shape" CHECK ((case when jsonb_typeof("after") = 'object' then "after" ? 'type' and "after" ? 'value' and "after" - 'type' - 'value' = '{}'::jsonb and jsonb_typeof("after" -> 'type') = 'string' and "after" ->> 'type' in ('text', 'number', 'duration', 'date', 'single_select', 'multi_select', 'person', 'boolean', 'url') else false end) is true),
	CONSTRAINT "task_field_value_history_before_shape" CHECK ("before" is null or (case when jsonb_typeof("before") = 'object' then "before" ? 'type' and "before" ? 'value' and "before" - 'type' - 'value' = '{}'::jsonb and jsonb_typeof("before" -> 'type') = 'string' and "before" ->> 'type' = "after" ->> 'type' else false end) is true)
);
--> statement-breakpoint
CREATE TABLE "task_field_values" (
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"field_type" "task_field_type" NOT NULL,
	"definition_version_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_field_values_pk" PRIMARY KEY("workspace_id","task_id","field_id"),
	CONSTRAINT "task_field_values_revision_positive" CHECK (revision >= 1),
	CONSTRAINT "task_field_values_value_shape" CHECK ((case when jsonb_typeof(value) = 'object' then value ? 'type' and value ? 'value' and value - 'type' - 'value' = '{}'::jsonb and jsonb_typeof(value -> 'type') = 'string' else false end) is true),
	CONSTRAINT "task_field_values_value_type_matches" CHECK ((value ->> 'type' = field_type::text) is true),
	CONSTRAINT "task_field_values_value_primitive" CHECK ((jsonb_typeof(value -> 'value') = 'null' or case
        when field_type = 'text' then jsonb_typeof(value -> 'value') = 'string' and char_length(value ->> 'value') <= 10000
        when field_type = 'number' then case when jsonb_typeof(value -> 'value') = 'number' then (value -> 'value')::numeric between -1000000000000 and 1000000000000 else false end
        when field_type = 'duration' then case when jsonb_typeof(value -> 'value') = 'number' then (value -> 'value')::numeric between 0 and 2147483647 and (value -> 'value')::numeric = trunc((value -> 'value')::numeric) else false end
        when field_type = 'date' then jsonb_typeof(value -> 'value') = 'string' and value ->> 'value' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        when field_type = 'single_select' then jsonb_typeof(value -> 'value') = 'string' and value ->> 'value' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        when field_type in ('multi_select', 'person') then case when jsonb_typeof(value -> 'value') = 'array' then jsonb_array_length(value -> 'value') <= 100 and not jsonb_path_exists(value -> 'value', '$[*] ? (@.type() != "string" || !(@ like_regex "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"))') else false end
        when field_type = 'boolean' then jsonb_typeof(value -> 'value') = 'boolean'
        when field_type = 'url' then jsonb_typeof(value -> 'value') = 'string' and char_length(value ->> 'value') <= 2048 and value ->> 'value' ~* '^https?://'
        else false
      end) is true)
);
--> statement-breakpoint
ALTER TABLE "project_column_settings" ADD CONSTRAINT "project_column_settings_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_columns" ADD CONSTRAINT "project_columns_settings_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."project_column_settings"("workspace_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_columns" ADD CONSTRAINT "project_columns_field_fk" FOREIGN KEY ("workspace_id","project_id","field_id") REFERENCES "public"."task_field_definitions"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_field_definition_versions" ADD CONSTRAINT "task_field_definition_versions_field_fk" FOREIGN KEY ("workspace_id","project_id","field_id") REFERENCES "public"."task_field_definitions"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_field_definitions" ADD CONSTRAINT "task_field_definitions_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_field_options" ADD CONSTRAINT "task_field_options_field_fk" FOREIGN KEY ("workspace_id","project_id","field_id") REFERENCES "public"."task_field_definitions"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_field_value_history" ADD CONSTRAINT "task_field_value_history_task_fk" FOREIGN KEY ("workspace_id","project_id","task_id") REFERENCES "public"."tasks"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_field_value_history" ADD CONSTRAINT "task_field_value_history_field_fk" FOREIGN KEY ("workspace_id","project_id","field_id") REFERENCES "public"."task_field_definitions"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_field_value_history" ADD CONSTRAINT "task_field_value_history_definition_version_fk" FOREIGN KEY ("workspace_id","project_id","field_id","definition_version_id") REFERENCES "public"."task_field_definition_versions"("workspace_id","project_id","field_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_field_value_history" ADD CONSTRAINT "task_field_value_history_actor_user_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_field_values" ADD CONSTRAINT "task_field_values_task_fk" FOREIGN KEY ("workspace_id","project_id","task_id") REFERENCES "public"."tasks"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_field_values" ADD CONSTRAINT "task_field_values_field_type_fk" FOREIGN KEY ("workspace_id","project_id","field_id","field_type") REFERENCES "public"."task_field_definitions"("workspace_id","project_id","id","type") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_field_values" ADD CONSTRAINT "task_field_values_definition_version_fk" FOREIGN KEY ("workspace_id","project_id","field_id","definition_version_id") REFERENCES "public"."task_field_definition_versions"("workspace_id","project_id","field_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "task_field_definitions_project_name_unique_idx" ON "task_field_definitions" USING btree ("workspace_id","project_id",lower(name));--> statement-breakpoint
CREATE UNIQUE INDEX "task_field_options_field_name_unique_idx" ON "task_field_options" USING btree ("workspace_id","project_id","field_id",lower(name));--> statement-breakpoint
CREATE INDEX "task_field_value_history_keyset_idx" ON "task_field_value_history" USING btree ("workspace_id","task_id","field_id","change_seq","event_ordinal","id");--> statement-breakpoint
CREATE INDEX "task_field_values_field_idx" ON "task_field_values" USING btree ("workspace_id","project_id","field_id");--> statement-breakpoint
-- Hand-written, SQL-only guards (not in the Drizzle schema or snapshot, like the P0 audit trigger).
-- Current-version FK: a definition is inserted before its first immutable version in the same
-- transaction, so the check is deferred to commit; definition_version_id stays NOT NULL.
ALTER TABLE "public"."task_field_definitions" ADD CONSTRAINT "task_field_definitions_current_version_fk" FOREIGN KEY ("workspace_id","project_id","id","definition_version_id") REFERENCES "public"."task_field_definition_versions"("workspace_id","project_id","field_id","id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
-- Definition versions are append-only.
CREATE FUNCTION "public"."workloom_reject_field_definition_version_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'task_field_definition_versions rows are immutable' USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "task_field_definition_versions_immutable_rows" BEFORE UPDATE OR DELETE ON "public"."task_field_definition_versions" FOR EACH ROW EXECUTE FUNCTION "public"."workloom_reject_field_definition_version_mutation"();--> statement-breakpoint
CREATE TRIGGER "task_field_definition_versions_immutable_truncate" BEFORE TRUNCATE ON "public"."task_field_definition_versions" FOR EACH STATEMENT EXECUTE FUNCTION "public"."workloom_reject_field_definition_version_mutation"();--> statement-breakpoint
-- Value history is append-only; turning history off never deletes recorded entries.
CREATE FUNCTION "public"."workloom_reject_field_value_history_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'task_field_value_history rows are immutable' USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "task_field_value_history_immutable_rows" BEFORE UPDATE OR DELETE ON "public"."task_field_value_history" FOR EACH ROW EXECUTE FUNCTION "public"."workloom_reject_field_value_history_mutation"();--> statement-breakpoint
CREATE TRIGGER "task_field_value_history_immutable_truncate" BEFORE TRUNCATE ON "public"."task_field_value_history" FOR EACH STATEMENT EXECUTE FUNCTION "public"."workloom_reject_field_value_history_mutation"();--> statement-breakpoint
-- A field type never changes in this slice, even for a field without values.
CREATE FUNCTION "public"."workloom_reject_field_type_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW."type" IS DISTINCT FROM OLD."type" THEN
		RAISE EXCEPTION 'task_field_definitions.type is immutable' USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "task_field_definitions_type_immutable" BEFORE UPDATE OF "type" ON "public"."task_field_definitions" FOR EACH ROW EXECUTE FUNCTION "public"."workloom_reject_field_type_change"();--> statement-breakpoint
-- A version snapshot must carry its definition's type. A missing definition is left to
-- task_field_definition_versions_field_fk (23503); identity keys are checked by the table CHECK.
CREATE FUNCTION "public"."workloom_check_field_definition_version_type"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	v_field_type "public"."task_field_type";
BEGIN
	SELECT d."type" INTO v_field_type
	FROM "public"."task_field_definitions" AS d
	WHERE d."workspace_id" = NEW."workspace_id" AND d."project_id" = NEW."project_id" AND d."id" = NEW."field_id";
	IF NOT FOUND THEN
		RETURN NEW;
	END IF;
	IF (NEW."snapshot" ->> 'type' = v_field_type::text) IS NOT TRUE THEN
		RAISE EXCEPTION 'task_field_definition_versions snapshot type must match the field type' USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "task_field_definition_versions_type_guard" BEFORE INSERT ON "public"."task_field_definition_versions" FOR EACH ROW EXECUTE FUNCTION "public"."workloom_check_field_definition_version_type"();--> statement-breakpoint
-- History before/after discriminators must match the referenced version's snapshot type and the
-- field type. A missing version is left to task_field_value_history_definition_version_fk (23503).
CREATE FUNCTION "public"."workloom_check_field_value_history_type"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	v_version_type text;
	v_field_type "public"."task_field_type";
BEGIN
	SELECT v."snapshot" ->> 'type', d."type" INTO v_version_type, v_field_type
	FROM "public"."task_field_definition_versions" AS v
	JOIN "public"."task_field_definitions" AS d
		ON d."workspace_id" = v."workspace_id" AND d."project_id" = v."project_id" AND d."id" = v."field_id"
	WHERE v."workspace_id" = NEW."workspace_id" AND v."project_id" = NEW."project_id"
		AND v."field_id" = NEW."field_id" AND v."id" = NEW."definition_version_id";
	IF NOT FOUND THEN
		RETURN NEW;
	END IF;
	IF (v_version_type = v_field_type::text) IS NOT TRUE
		OR (NEW."after" ->> 'type' = v_field_type::text) IS NOT TRUE
		OR (NEW."before" IS NOT NULL AND (NEW."before" ->> 'type' = v_field_type::text) IS NOT TRUE) THEN
		RAISE EXCEPTION 'task_field_value_history value type must match the field type' USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "task_field_value_history_type_guard" BEFORE INSERT ON "public"."task_field_value_history" FOR EACH ROW EXECUTE FUNCTION "public"."workloom_check_field_value_history_type"();