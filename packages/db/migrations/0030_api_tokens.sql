-- Personal access tokens for the public API and remote MCP. Only the SHA-256 of the secret is stored.
CREATE TABLE "api_tokens" (
  "id" uuid PRIMARY KEY NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id"),
  "name" text NOT NULL,
  "token_hash" text NOT NULL,
  "token_prefix" text NOT NULL,
  "scopes" jsonb NOT NULL,
  "workspace_ids" jsonb,
  "created_at" timestamp with time zone NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  "last_used_at" timestamp with time zone,
  CONSTRAINT "api_tokens_hash_unique" UNIQUE ("token_hash"),
  CONSTRAINT "api_tokens_shape" CHECK (
    char_length(btrim("name")) between 1 and 100
    AND "token_hash" ~ '^[a-f0-9]{64}$'
    AND char_length("token_prefix") between 8 and 16
    AND jsonb_typeof("scopes") = 'array' AND jsonb_array_length("scopes") between 1 and 2
    AND ("workspace_ids" IS NULL OR (jsonb_typeof("workspace_ids") = 'array' AND jsonb_array_length("workspace_ids") <= 100))
    AND "expires_at" > "created_at" AND "expires_at" <= "created_at" + interval '366 days'
  )
);
--> statement-breakpoint
CREATE INDEX "api_tokens_user_idx" ON "api_tokens" ("user_id", "created_at");
--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "api_token_id" uuid REFERENCES "api_tokens"("id");
