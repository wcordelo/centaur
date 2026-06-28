export type SqlRow = Record<string, SqlStorageValue>

export function sqlOneRow(sql: SqlStorage, query: string, ...params: unknown[]): SqlRow | null {
  const cursor = sql.exec(query, ...params)
  for (const row of cursor) {
    return row
  }
  return null
}

export function sqlString(row: SqlRow | null, key: string): string | undefined {
  const value = row?.[key]
  return typeof value === 'string' ? value : undefined
}

export function sqlNumber(row: SqlRow | null, key: string): number | undefined {
  const value = row?.[key]
  return typeof value === 'number' ? value : undefined
}
