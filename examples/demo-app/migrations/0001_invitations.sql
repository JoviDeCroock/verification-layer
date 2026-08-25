CREATE TABLE invitations (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX invitations_email_idx ON invitations(email);
CREATE UNIQUE INDEX invitations_dedupe_key_unique ON invitations(dedupe_key);
