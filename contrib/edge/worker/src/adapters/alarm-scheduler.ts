import { sqlNumber, sqlOneRow, sqlString } from '../db/sql'

export type AlarmKind = 'fiber_step' | 'outbox_retry' | 'external_poll' | 'prune'

export interface AlarmItem {
  id: string
  kind: AlarmKind
  runAtMs: number
  payload?: Record<string, unknown>
  priority?: number
}

const PRIORITY: Record<AlarmKind, number> = {
  fiber_step: 100,
  outbox_retry: 80,
  external_poll: 60,
  prune: 10,
}

function parseAlarmKind(value: string | undefined): AlarmKind {
  if (value === 'fiber_step' || value === 'outbox_retry' || value === 'external_poll' || value === 'prune') {
    return value
  }
  return 'prune'
}

export class AlarmScheduler {
  constructor(
    private readonly sql: SqlStorage,
    private readonly ctx: DurableObjectState
  ) {}

  schedule(item: AlarmItem): void {
    this.sql.exec(
      `INSERT INTO alarm_queue (id, kind, run_at_ms, payload, priority)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         kind = excluded.kind,
         run_at_ms = excluded.run_at_ms,
         payload = excluded.payload,
         priority = excluded.priority`,
      item.id,
      item.kind,
      item.runAtMs,
      item.payload ? JSON.stringify(item.payload) : null,
      item.priority ?? PRIORITY[item.kind]
    )
    void this.syncNextAlarm()
  }

  async syncNextAlarm(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm()
    const row = sqlOneRow(
      this.sql,
      `SELECT run_at_ms FROM alarm_queue
       ORDER BY priority DESC, run_at_ms ASC
       LIMIT 1`
    )
    const runAtMs = sqlNumber(row, 'run_at_ms')

    if (runAtMs === undefined) {
      if (existing !== null) {
        await this.ctx.storage.deleteAlarm()
      }
      return
    }

    if (existing === runAtMs) {
      return
    }
    await this.ctx.storage.setAlarm(runAtMs)
  }

  popDue(nowMs: number): AlarmItem | null {
    const row = sqlOneRow(
      this.sql,
      `SELECT id, kind, run_at_ms, payload, priority FROM alarm_queue
       WHERE run_at_ms <= ?
       ORDER BY priority DESC, run_at_ms ASC
       LIMIT 1`,
      nowMs
    )

    if (!row) return null

    const id = sqlString(row, 'id')
    if (!id) return null

    this.sql.exec(`DELETE FROM alarm_queue WHERE id = ?`, id)
    const payloadRaw = sqlString(row, 'payload')
    return {
      id,
      kind: parseAlarmKind(sqlString(row, 'kind')),
      runAtMs: sqlNumber(row, 'run_at_ms') ?? nowMs,
      payload: payloadRaw ? (JSON.parse(payloadRaw) as Record<string, unknown>) : undefined,
      priority: sqlNumber(row, 'priority'),
    }
  }
}
