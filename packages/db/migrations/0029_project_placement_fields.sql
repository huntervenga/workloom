-- Project-scoped ordinary fields may describe a canonical task placed in several projects.
-- Retained placements preserve the structural identity of immutable value history after detach.
ALTER TABLE "task_field_values" DROP CONSTRAINT "task_field_values_task_fk";
--> statement-breakpoint
ALTER TABLE "task_field_values" ADD CONSTRAINT "task_field_values_task_fk"
  FOREIGN KEY ("workspace_id", "task_id", "project_id")
  REFERENCES "task_project_placements" ("workspace_id", "task_id", "project_id");
--> statement-breakpoint
ALTER TABLE "task_field_value_history" DROP CONSTRAINT "task_field_value_history_task_fk";
--> statement-breakpoint
ALTER TABLE "task_field_value_history" ADD CONSTRAINT "task_field_value_history_task_fk"
  FOREIGN KEY ("workspace_id", "task_id", "project_id")
  REFERENCES "task_project_placements" ("workspace_id", "task_id", "project_id");
--> statement-breakpoint
ALTER TABLE "task_field_policy_usage" DROP CONSTRAINT "task_field_policy_usage_task_fk";
--> statement-breakpoint
ALTER TABLE "task_field_policy_usage" ADD CONSTRAINT "task_field_policy_usage_task_fk"
  FOREIGN KEY ("workspace_id", "task_id", "project_id")
  REFERENCES "task_project_placements" ("workspace_id", "task_id", "project_id");
