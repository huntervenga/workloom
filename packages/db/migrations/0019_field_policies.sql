CREATE TABLE "public"."task_field_policies" (
  "workspace_id" uuid NOT NULL, "project_id" uuid NOT NULL, "field_id" uuid NOT NULL,
  "revision" integer NOT NULL CONSTRAINT "task_field_policies_revision_positive" CHECK (revision >= 1), "lock_at" timestamptz,
  "max_changes_per_actor" integer CONSTRAINT "task_field_policies_limit_range" CHECK (max_changes_per_actor IS NULL OR max_changes_per_actor BETWEEN 0 AND 1000000), "activated_at" timestamptz,
  "updated_at" timestamptz NOT NULL, "updated_by_user_id" uuid NOT NULL CONSTRAINT "task_field_policies_updated_by_user_id_users_id_fk" REFERENCES "public"."users"("id"),
  CONSTRAINT "task_field_policies_pk" PRIMARY KEY (workspace_id,field_id),
  CONSTRAINT "task_field_policies_field_fk" FOREIGN KEY (workspace_id,project_id,field_id) REFERENCES "public"."task_field_definitions"(workspace_id,project_id,id),
  CONSTRAINT "task_field_policies_activation_required" CHECK ((lock_at IS NULL AND max_changes_per_actor IS NULL) OR activated_at IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "public"."task_field_policy_usage" (
  "workspace_id" uuid NOT NULL, "project_id" uuid NOT NULL, "task_id" uuid NOT NULL, "field_id" uuid NOT NULL,
  "actor_user_id" uuid NOT NULL CONSTRAINT "task_field_policy_usage_actor_user_id_users_id_fk" REFERENCES "public"."users"("id"), "value_revision" integer NOT NULL,
  "policy_revision" integer NOT NULL, "exception" boolean NOT NULL, "recorded_at" timestamptz NOT NULL,
  CONSTRAINT "task_field_policy_usage_revisions_positive" CHECK (value_revision >= 1 AND policy_revision >= 1),
  CONSTRAINT "task_field_policy_usage_pk" PRIMARY KEY (workspace_id,task_id,field_id,value_revision),
  CONSTRAINT "task_field_policy_usage_task_fk" FOREIGN KEY (workspace_id,project_id,task_id) REFERENCES "public"."tasks"(workspace_id,project_id,id),
  CONSTRAINT "task_field_policy_usage_field_fk" FOREIGN KEY (workspace_id,project_id,field_id) REFERENCES "public"."task_field_definitions"(workspace_id,project_id,id)
);
--> statement-breakpoint
CREATE INDEX "task_field_policy_usage_actor_idx" ON "public"."task_field_policy_usage" (workspace_id,task_id,field_id,actor_user_id);
--> statement-breakpoint
CREATE FUNCTION "public"."workloom_guard_field_policy_activation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'field policies cannot be deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.activated_at IS NOT NULL AND NEW.activated_at IS DISTINCT FROM OLD.activated_at THEN
    RAISE EXCEPTION 'field policy activation is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
CREATE TRIGGER "task_field_policies_activation_immutable" BEFORE UPDATE OR DELETE ON "public"."task_field_policies" FOR EACH ROW EXECUTE FUNCTION "public"."workloom_guard_field_policy_activation"();
--> statement-breakpoint
CREATE TRIGGER "task_field_policy_usage_immutable_rows" BEFORE UPDATE OR DELETE ON "public"."task_field_policy_usage" FOR EACH ROW EXECUTE FUNCTION "public"."workloom_reject_field_value_history_mutation"();
--> statement-breakpoint
CREATE TRIGGER "task_field_policy_usage_immutable_truncate" BEFORE TRUNCATE ON "public"."task_field_policy_usage" FOR EACH STATEMENT EXECUTE FUNCTION "public"."workloom_reject_field_value_history_mutation"();
--> statement-breakpoint
CREATE TRIGGER "task_field_policies_no_truncate" BEFORE TRUNCATE ON "public"."task_field_policies" FOR EACH STATEMENT EXECUTE FUNCTION "public"."workloom_guard_field_policy_activation"();
