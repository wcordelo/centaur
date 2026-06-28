export type LogLevel = 'debug' | 'info' | 'warning' | 'error'

export interface LogFields {
  service?: string
  event: string
  msg?: string
  thread_key?: string
  task_id?: string
  actor?: string
  fiber_index?: number
  request_id?: string
  [key: string]: unknown
}

export function log(level: LogLevel, fields: LogFields): void {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    service: fields.service ?? 'centaur-edge',
    ...fields,
  })
  if (level === 'error') {
    console.error(line)
    return
  }
  if (level === 'warning') {
    console.warn(line)
    return
  }
  console.log(line)
}

export function logInfo(fields: LogFields): void {
  log('info', fields)
}

export function logError(fields: LogFields): void {
  log('error', fields)
}

export function logWarn(fields: LogFields): void {
  log('warning', fields)
}
