const SPILL_THRESHOLD_BYTES = 256 * 1024

export interface BlobStorageAdapter {
  putJson(key: string, value: unknown): Promise<{ r2Key: string; bytes: number }>
  getJson<T>(key: string): Promise<T | null>
}

export class R2BlobStorageAdapter implements BlobStorageAdapter {
  constructor(
    private readonly bucket: R2Bucket,
    private readonly prefix: string
  ) {}

  private objectKey(key: string): string {
    return `${this.prefix}/${key}.json`
  }

  async putJson(key: string, value: unknown): Promise<{ r2Key: string; bytes: number }> {
    const body = JSON.stringify(value)
    const bytes = new TextEncoder().encode(body).byteLength
    const r2Key = this.objectKey(key)
    await this.bucket.put(r2Key, body, {
      httpMetadata: { contentType: 'application/json' },
    })
    return { r2Key, bytes }
  }

  async getJson<T>(key: string): Promise<T | null> {
    const object = await this.bucket.get(this.objectKey(key))
    if (!object) return null
    return (await object.json()) as T
  }
}

export function shouldSpillToR2(payload: string): boolean {
  return new TextEncoder().encode(payload).byteLength > SPILL_THRESHOLD_BYTES
}

export interface StoredPayload {
  inline?: string
  r2_key?: string
  bytes?: number
}

export async function storePayload(
  sql: SqlStorage,
  blobs: BlobStorageAdapter,
  logId: string,
  payload: unknown
): Promise<StoredPayload> {
  const serialized = JSON.stringify(payload)
  if (!shouldSpillToR2(serialized)) {
    return { inline: serialized }
  }

  const { r2Key, bytes } = await blobs.putJson(logId, payload)
  const now = new Date().toISOString()
  sql.exec(
    `INSERT INTO blob_storage (log_id, r2_key, bytes, content_type, created_at)
     VALUES (?, ?, ?, 'application/json', ?)
     ON CONFLICT(log_id) DO UPDATE SET
       r2_key = excluded.r2_key,
       bytes = excluded.bytes,
       content_type = excluded.content_type,
       created_at = excluded.created_at`,
    logId,
    r2Key,
    bytes,
    now
  )
  return { r2_key: r2Key, bytes }
}
