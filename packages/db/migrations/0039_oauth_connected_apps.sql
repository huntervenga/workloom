ALTER TABLE api_tokens ADD COLUMN oauth_client_id text;
--> statement-breakpoint
CREATE TABLE oauth_clients (
  id text PRIMARY KEY CONSTRAINT oauth_clients_id_valid CHECK (id ~ '^wlm_client_[A-Za-z0-9_-]{22}$'),
  client_name text NOT NULL CONSTRAINT oauth_clients_name_length CHECK (char_length(client_name) BETWEEN 1 AND 200),
  redirect_uris jsonb NOT NULL CONSTRAINT oauth_clients_redirect_uris_array CHECK (jsonb_typeof(redirect_uris) = 'array'),
  created_at timestamptz NOT NULL,
  last_used_at timestamptz
);
--> statement-breakpoint
CREATE TABLE oauth_authorization_codes (
  code_hash text PRIMARY KEY CONSTRAINT oauth_codes_hash_valid CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  client_id text NOT NULL REFERENCES oauth_clients(id),
  user_id uuid NOT NULL REFERENCES users(id),
  redirect_uri text NOT NULL,
  code_challenge text NOT NULL CONSTRAINT oauth_codes_challenge_valid CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  scopes jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  api_token_id uuid REFERENCES api_tokens(id)
);
--> statement-breakpoint
CREATE TABLE oauth_tokens (
  token_hash text PRIMARY KEY CONSTRAINT oauth_tokens_hash_valid CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  api_token_id uuid NOT NULL REFERENCES api_tokens(id),
  kind text NOT NULL CONSTRAINT oauth_tokens_kind_valid CHECK (kind IN ('access', 'refresh')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
--> statement-breakpoint
CREATE INDEX oauth_tokens_grant_idx ON oauth_tokens(api_token_id);
--> statement-breakpoint
CREATE INDEX oauth_codes_expiry_idx ON oauth_authorization_codes(expires_at);
--> statement-breakpoint
CREATE INDEX api_tokens_oauth_client_idx ON api_tokens(user_id, oauth_client_id) WHERE oauth_client_id IS NOT NULL;
