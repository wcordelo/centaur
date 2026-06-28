-- Researcher DO schema (002)
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_state (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  version_id INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS research_log (
  id TEXT PRIMARY KEY,
  step_index INTEGER NOT NULL,
  status TEXT NOT NULL,
  tool_name TEXT,
  request TEXT,
  response TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS verified_facts (
  fact_hash TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  source_url TEXT,
  confidence REAL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  target_actor TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS processed_requests (
  request_id TEXT PRIMARY KEY,
  processed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS blob_storage (
  log_id TEXT PRIMARY KEY,
  r2_key TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alarm_queue (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  run_at_ms INTEGER NOT NULL,
  payload TEXT,
  priority INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS fact_edges (
  from_hash TEXT NOT NULL,
  to_hash TEXT NOT NULL,
  relation TEXT NOT NULL,
  PRIMARY KEY (from_hash, to_hash, relation)
);
