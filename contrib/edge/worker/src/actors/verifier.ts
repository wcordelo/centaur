import { ensureMigrated } from '../db/migrate'
import { sqlOneRow, sqlString } from '../db/sql'
import {
  VerifyInputSchema,
  VerifyResultSchema,
  type Env,
  type VerifyInput,
  type VerifyResult,
} from '../types'

export class Verifier {
  private sql!: SqlStorage

  constructor(
    private readonly ctx: DurableObjectState,
    _env: Env
  ) {}

  private async init(): Promise<void> {
    if (this.sql) return
    this.sql = await ensureMigrated(this.ctx, 'verifier')
  }

  async fetch(request: Request): Promise<Response> {
    await this.init()
    const url = new URL(request.url)

    if (request.method === 'POST' && url.pathname === '/verify') {
      const body = VerifyInputSchema.parse(await request.json())
      const result = await this.verify(body)
      return Response.json(result)
    }

    return new Response('not found', { status: 404 })
  }

  async verify(input: VerifyInput): Promise<VerifyResult> {
    await this.init()

    const cached = sqlOneRow(
      this.sql,
      `SELECT verdict FROM processed_requests WHERE request_id = ?`,
      input.request_id
    )
    const verdictRaw = sqlString(cached, 'verdict')
    if (verdictRaw) {
      return VerifyResultSchema.parse(JSON.parse(verdictRaw))
    }

    const issues: string[] = []
    if (input.summary.trim().length < 20) {
      issues.push('Summary too short')
    }
    if (input.citations.length === 0) {
      issues.push('Missing citations')
    }

    const result: VerifyResult = {
      verdict: issues.length > 0 ? 'revise' : 'pass',
      issues,
      revision_brief: issues.length > 0 ? 'Expand summary and add citations.' : undefined,
      request_id: input.request_id,
    }

    this.sql.exec(
      `INSERT INTO processed_requests (request_id, processed_at, verdict)
       VALUES (?, ?, ?)`,
      input.request_id,
      new Date().toISOString(),
      JSON.stringify(result)
    )

    return result
  }
}
