CREATE TABLE "local_mcp_credentials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"secret_hash" text NOT NULL,
	"hash_version" integer NOT NULL,
	"scopes" jsonb NOT NULL,
	"revision" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "local_mcp_credentials_scope_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "local_mcp_credentials_owner_scope_unique" UNIQUE("workspace_id","owner_user_id","id"),
	CONSTRAINT "local_mcp_credentials_shape_check" CHECK (char_length("local_mcp_credentials"."name") between 1 and 100 and "local_mcp_credentials"."secret_hash" ~ '^[a-f0-9]{64}$' and "local_mcp_credentials"."hash_version"=1 and "local_mcp_credentials"."expires_at" >= "local_mcp_credentials"."created_at"+interval '60 seconds' and "local_mcp_credentials"."expires_at" <= "local_mcp_credentials"."created_at"+interval '86400 seconds' and (("local_mcp_credentials"."revision"=1 and "local_mcp_credentials"."revoked_at" is null) or ("local_mcp_credentials"."revision"=2 and "local_mcp_credentials"."revoked_at" is not null)) and case when jsonb_typeof("local_mcp_credentials"."scopes")='array' then jsonb_array_length("local_mcp_credentials"."scopes") between 1 and 6 and "local_mcp_credentials"."scopes" <@ '["projects.read","tasks.read","members.read","fields.read","tasks.create","tasks.update"]'::jsonb else false end)
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "credential_id" uuid;--> statement-breakpoint
ALTER TABLE "local_mcp_credentials" ADD CONSTRAINT "local_mcp_credentials_owner_fk" FOREIGN KEY ("workspace_id","owner_user_id") REFERENCES "public"."memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "local_mcp_credentials_owner_idx" ON "local_mcp_credentials" USING btree ("workspace_id","owner_user_id");--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_credential_owner_fk" FOREIGN KEY ("workspace_id","actor_user_id","credential_id") REFERENCES "public"."local_mcp_credentials"("workspace_id","owner_user_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION workloom_local_credential_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Credential history is retained' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(NEW.scopes) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid credential scopes' USING ERRCODE='23514'; END IF;
 IF (SELECT count(DISTINCT value) FROM jsonb_array_elements_text(NEW.scopes)) <> jsonb_array_length(NEW.scopes) THEN RAISE EXCEPTION 'Duplicate or invalid credential scopes' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.revision<>1 OR NEW.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'Invalid initial credential revision' USING ERRCODE='23514'; END IF;
 ELSE
  IF ROW(NEW.id,NEW.workspace_id,NEW.owner_user_id,NEW.name,NEW.secret_hash,NEW.hash_version,NEW.scopes,NEW.created_at,NEW.expires_at) IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.owner_user_id,OLD.name,OLD.secret_hash,OLD.hash_version,OLD.scopes,OLD.created_at,OLD.expires_at) OR OLD.revision<>1 OR OLD.revoked_at IS NOT NULL OR NEW.revision<>2 OR NEW.revoked_at IS NULL OR NEW.revoked_at<NEW.created_at THEN RAISE EXCEPTION 'Only first revocation is mutable' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER local_mcp_credentials_head_guard BEFORE INSERT OR UPDATE OR DELETE ON local_mcp_credentials FOR EACH ROW EXECUTE FUNCTION workloom_local_credential_guard();
--> statement-breakpoint
CREATE TRIGGER local_mcp_credentials_truncate_guard BEFORE TRUNCATE ON local_mcp_credentials FOR EACH STATEMENT EXECUTE FUNCTION workloom_local_credential_guard();
