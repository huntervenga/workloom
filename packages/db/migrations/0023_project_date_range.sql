-- Additive optional project period only; existing rows stay NULL, no backfill.
ALTER TABLE "projects" ADD COLUMN "date_range_from" date;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "date_range_to" date;
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_date_range_check" CHECK (
 ("date_range_from" IS NULL AND "date_range_to" IS NULL) OR
 ("date_range_from" IS NOT NULL AND "date_range_to" IS NOT NULL AND "date_range_from" <= "date_range_to" AND "date_range_from" >= DATE '1900-01-01' AND "date_range_to" <= DATE '2200-12-31')
);
