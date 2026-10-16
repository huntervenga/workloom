CREATE TABLE "graph_layout_positions" (
	"workspace_id" uuid NOT NULL,
	"layout_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"x" double precision NOT NULL,
	"y" double precision NOT NULL,
	CONSTRAINT "graph_layout_positions_workspace_id_layout_id_task_id_pk" PRIMARY KEY("workspace_id","layout_id","task_id"),
	CONSTRAINT "graph_layout_positions_finite_check" CHECK ("graph_layout_positions"."x" between -100000 and 100000 and "graph_layout_positions"."y" between -100000 and 100000)
);
--> statement-breakpoint
CREATE TABLE "graph_layouts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"view_key" text NOT NULL,
	"revision" integer NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "graph_layouts_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "graph_layouts_identity_unique" UNIQUE("workspace_id","project_id","membership_id","view_key"),
	CONSTRAINT "graph_layouts_view_check" CHECK ("graph_layouts"."view_key" = 'default'),
	CONSTRAINT "graph_layouts_revision_check" CHECK ("graph_layouts"."revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "project_dependency_policies" (
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"revision" integer NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "project_dependency_policies_workspace_id_project_id_pk" PRIMARY KEY("workspace_id","project_id"),
	CONSTRAINT "project_dependency_policies_mode_check" CHECK ("project_dependency_policies"."mode" in ('warn','enforce')),
	CONSTRAINT "project_dependency_policies_revision_check" CHECK ("project_dependency_policies"."revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "task_dependencies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"predecessor_task_id" uuid NOT NULL,
	"successor_task_id" uuid NOT NULL,
	"type" text NOT NULL,
	"state" text NOT NULL,
	"revision" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "task_dependencies_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "task_dependencies_identity_unique" UNIQUE("workspace_id","predecessor_task_id","successor_task_id","type"),
	CONSTRAINT "task_dependencies_self_check" CHECK ("task_dependencies"."predecessor_task_id" <> "task_dependencies"."successor_task_id"),
	CONSTRAINT "task_dependencies_type_check" CHECK ("task_dependencies"."type" = 'finish_to_start'),
	CONSTRAINT "task_dependencies_state_check" CHECK ("task_dependencies"."state" in ('active','removed')),
	CONSTRAINT "task_dependencies_revision_check" CHECK ("task_dependencies"."revision" >= 1)
);
--> statement-breakpoint
ALTER TABLE "graph_layout_positions" ADD CONSTRAINT "graph_layout_positions_layout_fk" FOREIGN KEY ("workspace_id","layout_id") REFERENCES "public"."graph_layouts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_layout_positions" ADD CONSTRAINT "graph_layout_positions_task_fk" FOREIGN KEY ("workspace_id","task_id") REFERENCES "public"."tasks"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_layouts" ADD CONSTRAINT "graph_layouts_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_layouts" ADD CONSTRAINT "graph_layouts_membership_fk" FOREIGN KEY ("workspace_id","membership_id") REFERENCES "public"."memberships"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_dependency_policies" ADD CONSTRAINT "project_dependency_policies_project_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_predecessor_fk" FOREIGN KEY ("workspace_id","predecessor_task_id") REFERENCES "public"."tasks"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_successor_fk" FOREIGN KEY ("workspace_id","successor_task_id") REFERENCES "public"."tasks"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_dependencies_predecessor_idx" ON "task_dependencies" USING btree ("workspace_id","predecessor_task_id","state");--> statement-breakpoint
CREATE INDEX "task_dependencies_successor_idx" ON "task_dependencies" USING btree ("workspace_id","successor_task_id","state");--> statement-breakpoint
-- Stable natural identities survive removal/restoration; ordinary mutable state changes advance one revision.
CREATE FUNCTION workloom_p4a_head_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE mutable_keys text[];
BEGIN
 IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'P4a identities are retained; use the domain command' USING ERRCODE='42501'; END IF;
 IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
 mutable_keys:=CASE TG_TABLE_NAME WHEN 'task_dependencies' THEN ARRAY['state','revision','updated_at'] WHEN 'project_dependency_policies' THEN ARRAY['mode','revision','updated_at'] ELSE ARRAY['revision','updated_at'] END;
 IF (to_jsonb(NEW)-mutable_keys) IS DISTINCT FROM (to_jsonb(OLD)-mutable_keys) OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'Invalid P4a identity or revision' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER task_dependencies_identity_guard BEFORE UPDATE OR DELETE ON task_dependencies FOR EACH ROW EXECUTE FUNCTION workloom_p4a_head_guard();
--> statement-breakpoint
CREATE TRIGGER project_dependency_policies_identity_guard BEFORE UPDATE OR DELETE ON project_dependency_policies FOR EACH ROW EXECUTE FUNCTION workloom_p4a_head_guard();
--> statement-breakpoint
CREATE TRIGGER graph_layouts_identity_guard BEFORE UPDATE OR DELETE ON graph_layouts FOR EACH ROW EXECUTE FUNCTION workloom_p4a_head_guard();
--> statement-breakpoint
CREATE TRIGGER task_dependencies_truncate_guard BEFORE TRUNCATE ON task_dependencies FOR EACH STATEMENT EXECUTE FUNCTION workloom_p4a_head_guard();
--> statement-breakpoint
CREATE TRIGGER project_dependency_policies_truncate_guard BEFORE TRUNCATE ON project_dependency_policies FOR EACH STATEMENT EXECUTE FUNCTION workloom_p4a_head_guard();
--> statement-breakpoint
CREATE TRIGGER graph_layouts_truncate_guard BEFORE TRUNCATE ON graph_layouts FOR EACH STATEMENT EXECUTE FUNCTION workloom_p4a_head_guard();
--> statement-breakpoint
CREATE FUNCTION workloom_graph_position_limit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (SELECT count(*) FROM graph_layout_positions WHERE workspace_id=NEW.workspace_id AND layout_id=NEW.layout_id)>500 THEN RAISE EXCEPTION 'A personal graph layout contains at most500 positions' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER graph_layout_positions_limit AFTER INSERT OR UPDATE ON graph_layout_positions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION workloom_graph_position_limit();
