ALTER TYPE "public"."user_kind" ADD VALUE 'real';--> statement-breakpoint
CREATE TABLE "shared_auth_identities" (
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"user_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shared_auth_identities_pk" PRIMARY KEY("issuer","subject"),
	CONSTRAINT "shared_auth_identities_user_unique" UNIQUE("user_id"),
	CONSTRAINT "shared_auth_identities_values" CHECK (char_length("shared_auth_identities"."issuer") between 1 and 2048 and char_length("shared_auth_identities"."subject") between 1 and 255)
);
--> statement-breakpoint
CREATE TABLE "shared_auth_login_attempts" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"browser_hash" text NOT NULL,
	"return_to" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shared_auth_login_attempts_values" CHECK ("shared_auth_login_attempts"."state_hash" ~ '^[a-f0-9]{64}$' and "shared_auth_login_attempts"."browser_hash" ~ '^[a-f0-9]{64}$' and char_length("shared_auth_login_attempts"."return_to") between 1 and 2048),
	CONSTRAINT "shared_auth_login_attempts_times" CHECK (isfinite("shared_auth_login_attempts"."expires_at") and isfinite("shared_auth_login_attempts"."created_at"))
);
--> statement-breakpoint
CREATE TABLE "shared_auth_sessions" (
	"session_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"encrypted_tokens" text NOT NULL,
	"access_expires_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shared_auth_sessions_values" CHECK ("shared_auth_sessions"."session_hash" ~ '^[a-f0-9]{64}$' and octet_length("shared_auth_sessions"."encrypted_tokens") between 1 and 1048576 and "shared_auth_sessions"."revision" >= 1),
	CONSTRAINT "shared_auth_sessions_times" CHECK (isfinite("shared_auth_sessions"."access_expires_at") and isfinite("shared_auth_sessions"."expires_at") and ("shared_auth_sessions"."revoked_at" is null or isfinite("shared_auth_sessions"."revoked_at")) and isfinite("shared_auth_sessions"."created_at") and isfinite("shared_auth_sessions"."updated_at"))
);
--> statement-breakpoint
ALTER TABLE "shared_auth_identities" ADD CONSTRAINT "shared_auth_identities_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_auth_identities" ADD CONSTRAINT "shared_auth_identities_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_auth_identities" ADD CONSTRAINT "shared_auth_identities_membership_fk" FOREIGN KEY ("workspace_id","membership_id","user_id") REFERENCES "public"."memberships"("workspace_id","id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_auth_sessions" ADD CONSTRAINT "shared_auth_sessions_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shared_auth_login_attempts_expiry_idx" ON "shared_auth_login_attempts" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "shared_auth_sessions_user_idx" ON "shared_auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "shared_auth_sessions_expiry_idx" ON "shared_auth_sessions" USING btree ("expires_at");