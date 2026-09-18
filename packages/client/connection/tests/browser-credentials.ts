import type { Context } from '@deepseek-ai/cordis'
import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'

/** Credentials record key BrowserAuth uses for its signing secret. */
export const BROWSER_SECRET_RECORD_KEY = 'client-connection/browser-session'

/** Credentials record key the session registry persists its snapshot under. */
export const BROWSER_SESSIONS_RECORD_KEY = 'client-connection/browser-sessions'

/** Key-aware credential-record double for Connection authentication tests. */
export class RecordCredentials {
  readonly records = new Map<string, CredentialRecord | undefined>()
  discardWrites = false
  /** When set, every record write rejects with this value (durable-store failure). */
  writeError: unknown = undefined
  reads = 0
  modifies = 0

  /** The signing-secret record, the record most authentication tests inspect. */
  get record(): CredentialRecord | undefined {
    return this.records.get(BROWSER_SECRET_RECORD_KEY)
  }

  set record(value: CredentialRecord | undefined) {
    this.records.set(BROWSER_SECRET_RECORD_KEY, value)
  }

  private normalize(key: unknown): string {
    return typeof key === 'string' ? key : BROWSER_SECRET_RECORD_KEY
  }

  readRecord(key?: unknown): Promise<CredentialRecord | undefined> {
    this.reads += 1
    return Promise.resolve(this.records.get(this.normalize(key)))
  }

  async modifyRecord(
    key: unknown,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    this.modifies += 1
    if (this.writeError !== undefined) throw this.writeError
    const normalized = this.normalize(key)
    const next = await mutate(this.records.get(normalized))
    if (this.discardWrites) return undefined
    if (next !== undefined) this.records.set(normalized, next)
    return this.records.get(normalized)
  }

  deleteRecord(key: unknown = BROWSER_SECRET_RECORD_KEY): Promise<void> {
    this.records.delete(this.normalize(key))
    return Promise.resolve()
  }

  /** Settle every queued background snapshot write before asserting record counts. */
  async settle(): Promise<void> {
    for (let round = 0; round < 3; round += 1) {
      await new Promise<void>(resolve => setImmediate(resolve))
    }
  }
}

/** Provide the record operations Connection needs during authentication setup. */
export function provideBrowserCredentials(ctx: Context, store: RecordCredentials = new RecordCredentials()): RecordCredentials {
  ctx.provide('credentials', store as unknown as CredentialProvider)
  return store
}
