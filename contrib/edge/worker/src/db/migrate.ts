import orchestratorMigration from '../../migrations/001_orchestrator.sql?raw'
import researcherMigration from '../../migrations/002_researcher.sql?raw'
import verifierMigration from '../../migrations/003_verifier.sql?raw'
import { sqlOneRow } from './sql'

export type ActorKind = 'orchestrator' | 'researcher' | 'verifier'

const MIGRATIONS: Record<ActorKind, string> = {
  orchestrator: orchestratorMigration,
  researcher: researcherMigration,
  verifier: verifierMigration,
}

const SCHEMA_VERSION = '1'

function runMigration(sql: SqlStorage, migration: string): void {
  for (const statement of migration.split(';')) {
    const trimmed = statement.trim()
    if (!trimmed) continue
    sql.exec(trimmed)
  }
}

export async function migrateSchema(
  sql: SqlStorage,
  actor: ActorKind,
  codeVersion: string
): Promise<void> {
  runMigration(sql, MIGRATIONS[actor])

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
