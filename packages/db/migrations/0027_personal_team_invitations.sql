CREATE TABLE "team_pending_members" (
  "workspace_id" uuid NOT NULL,
  "membership_id" uuid NOT NULL,
  "placeholder_user_id" uuid NOT NULL REFERENCES "users"("id"),
  "first_name" text NOT NULL,
  "last_name" text NOT NULL,
  "email" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "claimed_at" timestamp with time zone,
  "claimed_by_user_id" uuid REFERENCES "users"("id"),
  CONSTRAINT "team_pending_members_pk" PRIMARY KEY (workspace_id,membership_id),
  CONSTRAINT "team_pending_members_email_unique" UNIQUE (workspace_id,email),
  CONSTRAINT "team_pending_members_placeholder_unique" UNIQUE (placeholder_user_id),
  CONSTRAINT "team_pending_members_membership_fk" FOREIGN KEY (workspace_id,membership_id) REFERENCES memberships(workspace_id,id),
  CONSTRAINT "team_pending_members_name" CHECK (char_length(btrim(first_name)) between 1 and 100 and char_length(last_name)<=100 and char_length(concat_ws(' ',first_name,nullif(last_name,'')))<=200),
  CONSTRAINT "team_pending_members_email" CHECK (email=lower(btrim(email)) and char_length(email) between 3 and 254),
  CONSTRAINT "team_pending_members_claim" CHECK ((claimed_at is null)=(claimed_by_user_id is null))
);
--> statement-breakpoint
ALTER TABLE "team_invitations" ADD COLUMN "recipient" jsonb;
--> statement-breakpoint
ALTER TABLE "team_invitations" ADD COLUMN "pending_membership_id" uuid;
--> statement-breakpoint
ALTER TABLE "team_invitations" ADD CONSTRAINT "team_invitations_pending_member_fk" FOREIGN KEY (workspace_id,pending_membership_id) REFERENCES memberships(workspace_id,id);
--> statement-breakpoint
ALTER TABLE "team_invitations" ADD CONSTRAINT "team_invitations_recipient_pair" CHECK ((recipient is null)=(pending_membership_id is null));
