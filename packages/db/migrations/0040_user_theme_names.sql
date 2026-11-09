ALTER TABLE "user_settings" DROP CONSTRAINT IF EXISTS "user_settings_document";
--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_document" CHECK ((
  jsonb_typeof(settings) = 'object'
  AND settings->'version' = '1'::jsonb
  AND jsonb_typeof(settings->'theme') = 'string'
  AND settings->>'theme' ~ '^[a-z][a-z0-9-]{0,39}$'
  AND octet_length(settings::text) <= 16384
) IS TRUE);
