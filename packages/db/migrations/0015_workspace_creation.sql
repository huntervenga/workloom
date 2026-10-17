CREATE TABLE "workspace_creation_receipts" (
	"actor_user_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"payload_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_creation_receipts_pk" PRIMARY KEY("actor_user_id","idempotency_key"),
	CONSTRAINT "workspace_creation_receipts_workspace_unique" UNIQUE("workspace_id"),
	CONSTRAINT "workspace_creation_receipts_values" CHECK ("workspace_creation_receipts"."idempotency_key" ~ '^[!-~]{1,128}$' and "workspace_creation_receipts"."payload_hash" ~ '^[0-9a-f]{64}$' and isfinite("workspace_creation_receipts"."created_at"))
);
--> statement-breakpoint
ALTER TABLE "workspace_creation_receipts" ADD CONSTRAINT "workspace_creation_receipts_actor_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_creation_receipts" ADD CONSTRAINT "workspace_creation_receipts_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;