-- Additive nullable configuration only. Existing rows remain NULL; no data backfill.
ALTER TABLE "generic_report_column_settings" ADD COLUMN "header_widgets" jsonb;
--> statement-breakpoint
ALTER TABLE "generic_report_column_settings" ADD CONSTRAINT "generic_report_columns_header_widgets"
CHECK ("header_widgets" IS NULL OR (jsonb_typeof("header_widgets")='array' AND jsonb_array_length("header_widgets")<=100));
