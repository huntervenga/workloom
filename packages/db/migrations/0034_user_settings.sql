CREATE TABLE "user_settings" (
  "user_id" uuid PRIMARY KEY REFERENCES "users" ("id"),
  "settings" jsonb NOT NULL,
  "revision" integer NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "user_settings_revision" CHECK (revision >= 1),
  CONSTRAINT "user_settings_time" CHECK (isfinite(updated_at)),
  CONSTRAINT "user_settings_document" CHECK ((
    jsonb_typeof(settings) = 'object'
    AND settings->'version' = '1'::jsonb
    AND jsonb_typeof(settings->'theme') = 'string'
    AND settings->>'theme' IN ('default', 'dark', 'light')
    AND octet_length(settings::text) <= 16384
  ) IS TRUE)
);
