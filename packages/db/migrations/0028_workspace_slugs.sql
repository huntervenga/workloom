CREATE TABLE "workspace_slug_aliases" (
  "slug" text PRIMARY KEY NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "workspace_slug_aliases_workspace_slug_unique" UNIQUE (workspace_id,slug),
  CONSTRAINT "workspace_slug_aliases_shape" CHECK (char_length(slug) between 3 and 63 and slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);
--> statement-breakpoint
CREATE INDEX "workspace_slug_aliases_workspace_idx" ON "workspace_slug_aliases" (workspace_id,slug);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "slug" text;
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "slug_revision" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_slug_unique" ON "workspaces" (slug);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_slug_revision_positive" CHECK (slug_revision >= 1);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_slug_shape" CHECK (slug is null or (char_length(slug) between 3 and 63 and slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'));
