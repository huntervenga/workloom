CREATE TABLE "planning_cutoff_automations" (
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"current_revision" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "planning_cutoff_automations_pk" PRIMARY KEY("workspace_id","period_id"),
	CONSTRAINT "planning_cutoff_automations_revision" CHECK ("planning_cutoff_automations"."current_revision" >= 1),
	CONSTRAINT "planning_cutoff_automations_times" CHECK (isfinite("planning_cutoff_automations"."created_at") and isfinite("planning_cutoff_automations"."updated_at") and "planning_cutoff_automations"."updated_at" >= "planning_cutoff_automations"."created_at")
);
--> statement-breakpoint
CREATE TABLE "planning_cutoff_discovery_state" (
	"key" text PRIMARY KEY NOT NULL,
	"revision" integer NOT NULL,
	"cycle_at" timestamp with time zone NOT NULL,
	"after_cutoff_at" timestamp with time zone,
	"after_period_id" uuid,
	"lease_owner" uuid,
	"lease_until" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "planning_cutoff_discovery_state_values" CHECK ("planning_cutoff_discovery_state"."key"='project_cutoff.v1' and "planning_cutoff_discovery_state"."revision" >= 1 and isfinite("planning_cutoff_discovery_state"."cycle_at") and (("planning_cutoff_discovery_state"."after_cutoff_at" is null) = ("planning_cutoff_discovery_state"."after_period_id" is null)) and (("planning_cutoff_discovery_state"."lease_owner" is null) = ("planning_cutoff_discovery_state"."lease_until" is null)) and ("planning_cutoff_discovery_state"."after_cutoff_at" is null or isfinite("planning_cutoff_discovery_state"."after_cutoff_at")) and ("planning_cutoff_discovery_state"."lease_until" is null or isfinite("planning_cutoff_discovery_state"."lease_until")) and ("planning_cutoff_discovery_state"."completed_at" is null or isfinite("planning_cutoff_discovery_state"."completed_at")))
);
--> statement-breakpoint
CREATE TABLE "planning_cutoff_grant_versions" (
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"scope" text NOT NULL,
	"state" text NOT NULL,
	"authorizer_user_id" uuid NOT NULL,
	"authorizer_membership_id" uuid NOT NULL,
	"activated_at" timestamp with time zone,
	"recorded_at" timestamp with time zone NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"actor_membership_id" uuid NOT NULL,
	"source" "command_source" NOT NULL,
	"change_seq" bigint NOT NULL,
	CONSTRAINT "planning_cutoff_grant_versions_pk" PRIMARY KEY("workspace_id","grant_id","revision"),
	CONSTRAINT "planning_cutoff_grant_versions_scope_unique" UNIQUE("workspace_id","project_id","period_id","grant_id","revision"),
	CONSTRAINT "planning_cutoff_grant_versions_values" CHECK ("planning_cutoff_grant_versions"."revision" >= 1 and "planning_cutoff_grant_versions"."change_seq" >= 1 and "planning_cutoff_grant_versions"."scope" = 'project_cutoff' and "planning_cutoff_grant_versions"."state" in ('active','revoked') and ("planning_cutoff_grant_versions"."state" <> 'active' or "planning_cutoff_grant_versions"."activated_at" is not null)),
	CONSTRAINT "planning_cutoff_grant_versions_times" CHECK (isfinite("planning_cutoff_grant_versions"."recorded_at") and ("planning_cutoff_grant_versions"."activated_at" is null or (isfinite("planning_cutoff_grant_versions"."activated_at") and "planning_cutoff_grant_versions"."activated_at" <= "planning_cutoff_grant_versions"."recorded_at")))
);
--> statement-breakpoint
CREATE TABLE "planning_cutoff_requests" (
	"workspace_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"grant_revision" integer NOT NULL,
	"period_revision" integer NOT NULL,
	"cutoff_at" timestamp with time zone NOT NULL,
	"source_manifest_hash" text NOT NULL,
	"payload_hash" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"source" "command_source" NOT NULL,
	"change_seq" bigint NOT NULL,
	"superseded_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"processed_actor_user_id" uuid,
	"processed_membership_id" uuid,
	"result" jsonb,
	CONSTRAINT "planning_cutoff_requests_pk" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "planning_cutoff_requests_values" CHECK ("planning_cutoff_requests"."grant_revision" >= 1 and "planning_cutoff_requests"."period_revision" >= 1 and "planning_cutoff_requests"."change_seq" >= 1 and "planning_cutoff_requests"."source_manifest_hash" ~ '^[a-f0-9]{64}$' and "planning_cutoff_requests"."payload_hash" ~ '^[a-f0-9]{64}$' and char_length("planning_cutoff_requests"."reason") between 1 and 80),
	CONSTRAINT "planning_cutoff_requests_receipt" CHECK (("planning_cutoff_requests"."processed_at" is null and "planning_cutoff_requests"."result" is null and "planning_cutoff_requests"."processed_actor_user_id" is null and "planning_cutoff_requests"."processed_membership_id" is null) or ("planning_cutoff_requests"."processed_at" is not null and "planning_cutoff_requests"."result" is not null and "planning_cutoff_requests"."processed_actor_user_id" is not null and "planning_cutoff_requests"."processed_membership_id" is not null and jsonb_typeof("planning_cutoff_requests"."result")='object')),
	CONSTRAINT "planning_cutoff_requests_times" CHECK (isfinite("planning_cutoff_requests"."cutoff_at") and isfinite("planning_cutoff_requests"."created_at") and ("planning_cutoff_requests"."processed_at" is null or isfinite("planning_cutoff_requests"."processed_at")) and ("planning_cutoff_requests"."superseded_at" is null or isfinite("planning_cutoff_requests"."superseded_at")))
);
--> statement-breakpoint
ALTER TABLE "planning_cutoff_automations" ADD CONSTRAINT "planning_cutoff_automations_current_grant_fk" FOREIGN KEY ("workspace_id","project_id","period_id","grant_id","current_revision") REFERENCES "public"."planning_cutoff_grant_versions"("workspace_id","project_id","period_id","grant_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_cutoff_grant_versions" ADD CONSTRAINT "planning_cutoff_grant_versions_period_fk" FOREIGN KEY ("workspace_id","project_id","period_id") REFERENCES "public"."planning_periods"("workspace_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_cutoff_grant_versions" ADD CONSTRAINT "planning_cutoff_grant_versions_authorizer_fk" FOREIGN KEY ("workspace_id","authorizer_membership_id","authorizer_user_id") REFERENCES "public"."memberships"("workspace_id","id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_cutoff_grant_versions" ADD CONSTRAINT "planning_cutoff_grant_versions_actor_fk" FOREIGN KEY ("workspace_id","actor_membership_id","actor_user_id") REFERENCES "public"."memberships"("workspace_id","id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_cutoff_requests" ADD CONSTRAINT "planning_cutoff_requests_grant_fk" FOREIGN KEY ("workspace_id","project_id","period_id","grant_id","grant_revision") REFERENCES "public"."planning_cutoff_grant_versions"("workspace_id","project_id","period_id","grant_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_cutoff_requests" ADD CONSTRAINT "planning_cutoff_requests_requester_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_cutoff_requests" ADD CONSTRAINT "planning_cutoff_requests_processor_fk" FOREIGN KEY ("workspace_id","processed_membership_id","processed_actor_user_id") REFERENCES "public"."memberships"("workspace_id","id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "planning_cutoff_requests_one_live_idx" ON "planning_cutoff_requests" USING btree ("workspace_id","period_id") WHERE "planning_cutoff_requests"."processed_at" is null and "planning_cutoff_requests"."superseded_at" is null;--> statement-breakpoint
CREATE INDEX "planning_cutoff_requests_period_idx" ON "planning_cutoff_requests" USING btree ("workspace_id","period_id","created_at","id");--> statement-breakpoint
CREATE INDEX "planning_periods_due_cutoff_idx" ON "planning_periods" USING btree ("cutoff_at","id") WHERE "planning_periods"."state"='planning';--> statement-breakpoint
CREATE FUNCTION public.workloom_reject_cutoff_grant_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'cutoff grant versions are immutable' USING ERRCODE='restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER cutoff_grants_immutable_rows BEFORE UPDATE OR DELETE ON public.planning_cutoff_grant_versions FOR EACH ROW EXECUTE FUNCTION public.workloom_reject_cutoff_grant_mutation();
--> statement-breakpoint
CREATE TRIGGER cutoff_grants_immutable_truncate BEFORE TRUNCATE ON public.planning_cutoff_grant_versions FOR EACH STATEMENT EXECUTE FUNCTION public.workloom_reject_cutoff_grant_mutation();
--> statement-breakpoint
CREATE FUNCTION public.workloom_protect_cutoff_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'cutoff requests cannot be removed' USING ERRCODE='restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['superseded_at','processed_at','processed_actor_user_id','processed_membership_id','result']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['superseded_at','processed_at','processed_actor_user_id','processed_membership_id','result']) THEN
    RAISE EXCEPTION 'cutoff request payload is immutable' USING ERRCODE='restrict_violation';
  END IF;
  IF OLD.result IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'cutoff receipt is immutable' USING ERRCODE='restrict_violation';
  END IF;
  IF OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at THEN
    RAISE EXCEPTION 'cutoff request supersession is immutable' USING ERRCODE='restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER cutoff_requests_protected_rows BEFORE UPDATE OR DELETE ON public.planning_cutoff_requests FOR EACH ROW EXECUTE FUNCTION public.workloom_protect_cutoff_request();
--> statement-breakpoint
CREATE TRIGGER cutoff_requests_protected_truncate BEFORE TRUNCATE ON public.planning_cutoff_requests FOR EACH STATEMENT EXECUTE FUNCTION public.workloom_protect_cutoff_request();
