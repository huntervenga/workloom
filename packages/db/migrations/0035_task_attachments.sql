CREATE TABLE task_attachments (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  task_id uuid NOT NULL,
  uploaded_by_user_id uuid NOT NULL REFERENCES users(id),
  file_name text NOT NULL,
  size_bytes integer NOT NULL CONSTRAINT task_attachments_size CHECK (size_bytes BETWEEN 0 AND 50000000),
  state text NOT NULL CONSTRAINT task_attachments_state CHECK (state IN ('pending','uploading','ready','failed','expired','deleted')),
  slot smallint NOT NULL CONSTRAINT task_attachments_slot_range CHECK (slot BETWEEN 1 AND 5),
  revision integer NOT NULL CONSTRAINT task_attachments_revision CHECK (revision >= 1),
  storage_id text NOT NULL CONSTRAINT task_attachments_storage CHECK (storage_id ~ '^[a-f0-9]{64}$'),
  object_key text NOT NULL UNIQUE,
  version_id text,
  checksum text CONSTRAINT task_attachments_checksum CHECK (checksum IS NULL OR checksum ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  upload_expires_at timestamptz NOT NULL,
  CONSTRAINT task_attachments_task_fk FOREIGN KEY (workspace_id, task_id) REFERENCES tasks(workspace_id, id),
  CONSTRAINT task_attachments_name CHECK (char_length(file_name) BETWEEN 1 AND 240 AND file_name !~ '[[:cntrl:]/\\]'),
  CONSTRAINT task_attachments_time CHECK (isfinite(created_at) AND isfinite(upload_expires_at) AND upload_expires_at > created_at),
  CONSTRAINT task_attachments_ready CHECK (state <> 'ready' OR checksum IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX task_attachments_slot ON task_attachments(workspace_id, task_id, slot)
  WHERE state IN ('pending','uploading','ready');
CREATE INDEX task_attachments_task ON task_attachments(workspace_id, task_id);
--> statement-breakpoint
-- Deliberately NO foreign keys: this durable object/cleanup record survives the purge FK closure.
-- Created before network I/O; a ready object has cleanup_at NULL. Deleted objects are rechecked
-- through the late-write window before retiring the job; rows retain their exact storage locator.
CREATE TABLE attachment_storage_objects (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  task_id uuid NOT NULL,
  storage_id text NOT NULL,
  object_key text NOT NULL UNIQUE,
  version_id text,
  write_deadline timestamptz NOT NULL,
  cleanup_at timestamptz,
  lease_until timestamptz,
  lease_token uuid,
  cleanup_attempts integer NOT NULL DEFAULT 0,
  last_error text,
  CONSTRAINT attachment_objects_storage CHECK (storage_id ~ '^[a-f0-9]{64}$'),
  CONSTRAINT attachment_objects_attempts CHECK (cleanup_attempts >= 0)
);
CREATE INDEX attachment_objects_cleanup ON attachment_storage_objects(storage_id, cleanup_at);
CREATE INDEX attachment_objects_task ON attachment_storage_objects(workspace_id, task_id);
