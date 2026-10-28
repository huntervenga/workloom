ALTER TABLE users ADD COLUMN avatar_id uuid;
ALTER TABLE users ADD COLUMN avatar_revision integer NOT NULL DEFAULT 0;
ALTER TABLE users ADD CONSTRAINT users_avatar_revision_valid CHECK (avatar_revision >= 0);
--> statement-breakpoint
CREATE TABLE avatar_storage_objects (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  expected_revision integer NOT NULL CONSTRAINT avatar_storage_revision_valid CHECK (expected_revision >= 0),
  storage_id text NOT NULL CONSTRAINT avatar_storage_id_valid CHECK (storage_id ~ '^[a-f0-9]{64}$'),
  object_key text NOT NULL UNIQUE,
  version_id text,
  state text NOT NULL CONSTRAINT avatar_storage_state_valid CHECK (state IN ('pending', 'ready', 'retired')),
  write_deadline timestamptz NOT NULL,
  cleanup_at timestamptz,
  lease_until timestamptz,
  lease_token uuid
);
--> statement-breakpoint
CREATE INDEX avatar_storage_cleanup_idx ON avatar_storage_objects(storage_id, cleanup_at);
CREATE INDEX avatar_storage_user_idx ON avatar_storage_objects(user_id);
