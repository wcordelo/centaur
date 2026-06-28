import { sqlOneRow, sqlString } from '../db/sql'

export interface StorageAdapter {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  exec(query: string, ...params: unknown[]): void
}

export class SqlStorageAdapter implements StorageAdapter {
  constructor(private readonly sql: SqlStorage) {}

  async get(key: string): Promise<string | null> {
    const row = sqlOneRow(this.sql, `SELECT data FROM session_state WHERE id = ?`, key)
    return sqlString(row, 'data') ?? null
  }

  async set(key: string, value: string): Promise<void> {
    const now = new Date().toISOString()
    this.sql.exec(
      `INSERT INTO session_state (id, data, version_id, updated_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(id) DO UPDATE SET
         data = excluded.data,
         version_id = session_state.version_id + 1,
         updated_at = excluded.updated_at`,
      key,
      value,
      now
    )
  }

  exec(query: string, ...params: unknown[]): void {
    this.sql.exec(query, ...params)
  }
}
