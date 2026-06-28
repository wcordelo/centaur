-- Verifier DO schema (003)
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS processed_requests (
  request_id TEXT PRIMARY KEY,
  processed_at TEXT NOT NULL,
  verdict TEXT NOT NULL
);
