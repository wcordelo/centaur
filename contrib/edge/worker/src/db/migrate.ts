import { sqlOneRow } from './sql'

const ORCHESTRATOR_MIGRATION = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS processed_slack_events (
  event_id TEXT PRIMARY KEY,
  processed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS processed_requests (
  request_id TEXT PRIMARY KEY,
  processed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  thread_key TEXT NOT NULL,
  status TEXT NOT NULL,
  objective TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_ts TEXT NOT NULL,
  deadline_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS delivery_obligations (
  id TEXT PRIMARY KEY,
  thread_key TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dead_letter (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL
);
`

const RESEARCHER_MIGRATION = `
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
`

const VERIFIER_MIGRATION = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS processed_requests (
  request_id TEXT PRIMARY KEY,
  processed_at TEXT NOT NULL,
  verdict TEXT NOT NULL
);
`

export type ActorKind = 'orchestrator' | 'researcher' | 'verifier'

const MIGRATIONS: Record<ActorKind, string> = {
  orchestrator: ORCHESTRATOR_MIGRATION,
  researcher: RESEARCHER_MIGRATION,
  verifier: VERIFIER_MIGRATION,
}

const SCHEMA_VERSION = '1'

export async function migrateSchema(
  sql: SqlStorage,
  actor: ActorKind,
  codeVersion: string
): Promise<void> {
  const migration = MIGRATIONS[actor]
  for (const statement of migration.split(';')) {
    const trimmed = statement.trim()
    if (!trimmed) continue
    sql.exec(trimmed)
  }

  sql.exec(
    `INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    SCHEMA_VERSION
  )
  sql.exec(
    `INSERT INTO schema_meta (key, value) VALUES ('code_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    codeVersion
  )
}

export async function ensureMigrated(
  ctx: DurableObjectState,
  actor: ActorKind,
  codeVersion = '0.0.1'
): Promise<SqlStorage> {
  let sql: SqlStorage | undefined
  await ctx.blockConcurrencyWhile(async () => {
    sql = ctx.storage.sql
    await migrateSchema(sql, actor, codeVersion)
  })
  if (!sql) {
    throw new Error('failed to initialize sqlite storage')
  }
  return sql
}

export function idempotentRequest(
  sql: SqlStorage,
  requestId: string
): { alreadyProcessed: boolean } {
  const row = sqlOneRow(
    sql,
    `SELECT request_id FROM processed_requests WHERE request_id = ?`,
    requestId
  )
  if (row) {
    return { alreadyProcessed: true }
  }
  sql.exec(
    `INSERT INTO processed_requests (request_id, processed_at) VALUES (?, ?)`,
    requestId,
    new Date().toISOString()
  )
  return { alreadyProcessed: false }
}
