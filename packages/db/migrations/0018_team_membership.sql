CREATE TABLE "team_invitations" (
 "id" uuid PRIMARY KEY NOT NULL, "workspace_id" uuid NOT NULL,
 "secret_hash" text NOT NULL, "hash_version" integer NOT NULL, "role" "workspace_role" NOT NULL,
 "created_by_user_id" uuid NOT NULL, "created_by_membership_id" uuid NOT NULL,
 "created_at" timestamp with time zone NOT NULL, "expires_at" timestamp with time zone NOT NULL,
 "revision" integer DEFAULT 1 NOT NULL, "revoked_at" timestamp with time zone,
 "accepted_at" timestamp with time zone, "accepted_by_user_id" uuid, "accepted_membership_id" uuid,
 CONSTRAINT "team_invitations_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id"),
 CONSTRAINT "team_invitations_issuer_fk" FOREIGN KEY ("workspace_id","created_by_membership_id","created_by_user_id") REFERENCES "memberships"("workspace_id","id","user_id"),
 CONSTRAINT "team_invitations_acceptor_fk" FOREIGN KEY ("workspace_id","accepted_membership_id","accepted_by_user_id") REFERENCES "memberships"("workspace_id","id","user_id"),
 CONSTRAINT "team_invitations_grant" CHECK (role <> 'owner' and hash_version = 1 and secret_hash ~ '^[a-f0-9]{64}$' and revision >= 1),
 CONSTRAINT "team_invitations_times" CHECK (isfinite(created_at) and isfinite(expires_at) and expires_at > created_at and expires_at <= created_at + interval '168 hours' and (revoked_at is null or (isfinite(revoked_at) and revoked_at >= created_at)) and (accepted_at is null or (isfinite(accepted_at) and accepted_at >= created_at))),
 CONSTRAINT "team_invitations_acceptance" CHECK ((accepted_at is null and accepted_by_user_id is null and accepted_membership_id is null) or (accepted_at is not null and accepted_by_user_id is not null and accepted_membership_id is not null and revoked_at is null))
);
--> statement-breakpoint
CREATE INDEX "team_invitations_workspace_idx" ON "team_invitations" ("workspace_id","created_at","id");
