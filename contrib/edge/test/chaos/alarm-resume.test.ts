import { describe, expect, it } from 'vitest'
import { AlarmScheduler } from '../../worker/src/adapters/alarm-scheduler'

class MemorySqlStorage {
  private tables = new Map<string, Map<string, Record<string, unknown>>>()

  exec(query: string, ...params: unknown[]): Iterable<Record<string, unknown>> {
    const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase()

    if (normalized.startsWith('insert into alarm_queue')) {
      const table = this.table('alarm_queue')
      const id = String(params[0])
      table.set(id, {
        id: params[0],
        kind: params[1],
        run_at_ms: params[2],
        payload: params[3],
        priority: params[4],
      })
      return emptyCursor()
    }

    if (normalized.startsWith('select run_at_ms from alarm_queue') && normalized.includes('order by')) {
      const rows = [...this.table('alarm_queue').values()].sort((a, b) => {
        const prio = Number(b.priority) - Number(a.priority)
        if (prio !== 0) return prio
        return Number(a.run_at_ms) - Number(b.run_at_ms)
      })
      return cursorFromRows(rows.slice(0, 1))
    }

    if (normalized.startsWith('select id, kind, run_at_ms')) {
      const nowMs = Number(params[0])
      const rows = [...this.table('alarm_queue').values()]
        .filter(row => Number(row.run_at_ms) <= nowMs)
        .sort((a, b) => {
          const prio = Number(b.priority) - Number(a.priority)
          if (prio !== 0) return prio
          return Number(a.run_at_ms) - Number(b.run_at_ms)
        })
      return cursorFromRows(rows.slice(0, 1))
    }

    if (normalized.startsWith('delete from alarm_queue')) {
      this.table('alarm_queue').delete(String(params[0]))
      return emptyCursor()
    }

    return emptyCursor()
  }

  private table(name: string): Map<string, Record<string, unknown>> {
    if (!this.tables.has(name)) {
      this.tables.set(name, new Map())
    }
    return this.tables.get(name)!
  }
}

function emptyCursor(): Iterable<Record<string, unknown>> {
  return {
    [Symbol.iterator]: function* () {},
  }
}

function cursorFromRows(rows: Record<string, unknown>[]): Iterable<Record<string, unknown>> {
  return {
    [Symbol.iterator]: function* () {
      for (const row of rows) {
        yield row
      }
    },
  }
}

class MemoryDurableState {
  private alarm: number | null = null

  storage = {
    getAlarm: async (): Promise<number | null> => this.alarm,
    setAlarm: async (time: number | Date): Promise<void> => {
      this.alarm = typeof time === 'number' ? time : time.getTime()
    },
    deleteAlarm: async (): Promise<void> => {
      this.alarm = null
    },
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm
  }
}

describe('AlarmScheduler chaos resume', () => {
  it('schedules highest-priority due alarm and syncs next wake time', async () => {
    const sql = new MemorySqlStorage() as unknown as SqlStorage
    const ctx = new MemoryDurableState() as unknown as DurableObjectState
    const scheduler = new AlarmScheduler(sql, ctx)

    scheduler.schedule({
      id: 'prune:1',
      kind: 'prune',
      runAtMs: Date.now() + 60_000,
    })
    scheduler.schedule({
      id: 'fiber:1',
      kind: 'fiber_step',
      runAtMs: Date.now() + 100,
    })

    await scheduler.syncNextAlarm()
    const firstAlarm = await (ctx as unknown as MemoryDurableState).getAlarm()
    expect(firstAlarm).not.toBeNull()

    const due = scheduler.popDue(Date.now() + 200)
    expect(due?.kind).toBe('fiber_step')

    await scheduler.syncNextAlarm()
    const secondAlarm = await (ctx as unknown as MemoryDurableState).getAlarm()
    expect(secondAlarm).toBeGreaterThan(Date.now())
  })
})
