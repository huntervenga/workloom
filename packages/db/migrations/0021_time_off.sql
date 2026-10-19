CREATE TABLE "leave_settings" (
 workspace_id uuid PRIMARY KEY REFERENCES workspaces(id),
 revision integer NOT NULL CHECK(revision>0),
 snapshot jsonb NOT NULL,
 updated_at timestamptz NOT NULL,
 CHECK ((snapshot->>'workspaceId'=workspace_id::text AND (snapshot->>'revision')::integer=revision) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "leave_settings_versions" (
 workspace_id uuid NOT NULL REFERENCES workspaces(id),
 revision integer NOT NULL CHECK(revision>0),
 snapshot jsonb NOT NULL,
 actor_membership_id uuid NOT NULL,
 reason text NOT NULL,
 recorded_at timestamptz NOT NULL,
 PRIMARY KEY(workspace_id,revision),
 FOREIGN KEY (workspace_id,actor_membership_id) REFERENCES memberships(workspace_id,id),
 CHECK ((snapshot->>'workspaceId'=workspace_id::text AND (snapshot->>'revision')::integer=revision) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "leave_profiles" (
 workspace_id uuid NOT NULL,
 membership_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0),
 snapshot jsonb NOT NULL,
 updated_at timestamptz NOT NULL,
 PRIMARY KEY(workspace_id,membership_id),
 FOREIGN KEY (workspace_id,membership_id) REFERENCES memberships(workspace_id,id),
 CHECK ((snapshot->>'workspaceId'=workspace_id::text AND snapshot->>'membershipId'=membership_id::text AND (snapshot->>'revision')::integer=revision) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "leave_profile_versions" (
 workspace_id uuid NOT NULL,
 membership_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0),
 snapshot jsonb NOT NULL,
 actor_membership_id uuid NOT NULL,
 reason text NOT NULL,
 recorded_at timestamptz NOT NULL,
 PRIMARY KEY(workspace_id,membership_id,revision),
 FOREIGN KEY (workspace_id,membership_id) REFERENCES memberships(workspace_id,id),
 FOREIGN KEY (workspace_id,actor_membership_id) REFERENCES memberships(workspace_id,id),
 CHECK ((snapshot->>'workspaceId'=workspace_id::text AND snapshot->>'membershipId'=membership_id::text AND (snapshot->>'revision')::integer=revision) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "leave_requests" (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL,
 membership_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0),
 snapshot jsonb NOT NULL,
 updated_at timestamptz NOT NULL,
 CONSTRAINT leave_requests_scope_unique UNIQUE(workspace_id,id),
 FOREIGN KEY (workspace_id,membership_id) REFERENCES memberships(workspace_id,id),
 CHECK ((snapshot->>'workspaceId'=workspace_id::text AND snapshot->>'id'=id::text AND snapshot->>'membershipId'=membership_id::text AND (snapshot->>'revision')::integer=revision) IS TRUE)
);
--> statement-breakpoint
CREATE INDEX leave_requests_member_idx ON leave_requests(workspace_id,membership_id);
--> statement-breakpoint
CREATE TABLE "leave_request_versions" (
 workspace_id uuid NOT NULL,
 request_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0),
 snapshot jsonb NOT NULL,
 actor_membership_id uuid NOT NULL,
 reason text NOT NULL,
 recorded_at timestamptz NOT NULL,
 PRIMARY KEY(workspace_id,request_id,revision),
 FOREIGN KEY(workspace_id,request_id) REFERENCES leave_requests(workspace_id,id),
 FOREIGN KEY (workspace_id,actor_membership_id) REFERENCES memberships(workspace_id,id),
 CHECK ((snapshot->>'workspaceId'=workspace_id::text AND snapshot->>'id'=request_id::text AND (snapshot->>'revision')::integer=revision) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "leave_charge_ledger" (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL,
 request_id uuid NOT NULL,
 request_revision integer NOT NULL,
 membership_id uuid NOT NULL,
 type_id uuid NOT NULL,
 date date NOT NULL,
 delta_microdays bigint NOT NULL,
 scheduled_minutes integer NOT NULL,
 recorded_at timestamptz NOT NULL,
 FOREIGN KEY(workspace_id,request_id,request_revision) REFERENCES leave_request_versions(workspace_id,request_id,revision),
 FOREIGN KEY (workspace_id,membership_id) REFERENCES memberships(workspace_id,id),
 CONSTRAINT leave_charge_ledger_revision_day UNIQUE(workspace_id,request_id,request_revision,date),
 CHECK(delta_microdays BETWEEN -1000000000000 AND 1000000000000 AND scheduled_minutes BETWEEN 0 AND 1440)
);
--> statement-breakpoint
CREATE TABLE "leave_adjustments" (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL,
 membership_id uuid NOT NULL,
 snapshot jsonb NOT NULL,
 actor_membership_id uuid NOT NULL,
 recorded_at timestamptz NOT NULL,
 FOREIGN KEY (workspace_id,membership_id) REFERENCES memberships(workspace_id,id),
 FOREIGN KEY (workspace_id,actor_membership_id) REFERENCES memberships(workspace_id,id),
 CHECK ((snapshot->>'id'=id::text AND snapshot->>'membershipId'=membership_id::text) IS TRUE)
);
--> statement-breakpoint
CREATE TRIGGER leave_settings_versions_immutable_rows BEFORE UPDATE OR DELETE ON leave_settings_versions FOR EACH ROW EXECUTE FUNCTION workloom_reject_field_value_history_mutation();
--> statement-breakpoint
CREATE TRIGGER leave_settings_versions_immutable_truncate BEFORE TRUNCATE ON leave_settings_versions FOR EACH STATEMENT EXECUTE FUNCTION workloom_reject_field_value_history_mutation();
--> statement-breakpoint
CREATE TRIGGER leave_profile_versions_immutable_rows BEFORE UPDATE OR DELETE ON leave_profile_versions FOR EACH ROW EXECUTE FUNCTION workloom_reject_field_value_history_mutation();
--> statement-breakpoint
CREATE TRIGGER leave_profile_versions_immutable_truncate BEFORE TRUNCATE ON leave_profile_versions FOR EACH STATEMENT EXECUTE FUNCTION workloom_reject_field_value_history_mutation();
--> statement-breakpoint
CREATE TRIGGER leave_request_versions_immutable_rows BEFORE UPDATE OR DELETE ON leave_request_versions FOR EACH ROW EXECUTE FUNCTION workloom_reject_field_value_history_mutation();
--> statement-breakpoint
CREATE TRIGGER leave_request_versions_immutable_truncate BEFORE TRUNCATE ON leave_request_versions FOR EACH STATEMENT EXECUTE FUNCTION workloom_reject_field_value_history_mutation();
--> statement-breakpoint
CREATE TRIGGER leave_charge_ledger_immutable_rows BEFORE UPDATE OR DELETE ON leave_charge_ledger FOR EACH ROW EXECUTE FUNCTION workloom_reject_field_value_history_mutation();
--> statement-breakpoint
CREATE TRIGGER leave_charge_ledger_immutable_truncate BEFORE TRUNCATE ON leave_charge_ledger FOR EACH STATEMENT EXECUTE FUNCTION workloom_reject_field_value_history_mutation();
--> statement-breakpoint
CREATE TRIGGER leave_adjustments_immutable_rows BEFORE UPDATE OR DELETE ON leave_adjustments FOR EACH ROW EXECUTE FUNCTION workloom_reject_field_value_history_mutation();
--> statement-breakpoint
CREATE TRIGGER leave_adjustments_immutable_truncate BEFORE TRUNCATE ON leave_adjustments FOR EACH STATEMENT EXECUTE FUNCTION workloom_reject_field_value_history_mutation();
