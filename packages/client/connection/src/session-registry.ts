/**
 * Server-side registry of browser sessions. The signed cookie names one
 * registered session; verification additionally requires that the session
 * exists and has not been revoked, so minting or revoking a record invalidates
 * the matching cookies without changing the signing secret.
 * @module
 */

import { randomBytes } from 'node:crypto'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { encodeBase64Url } from './token-encoding.ts'

/** Version of the persisted registry snapshot. */
const STORED_REGISTRY_VERSION = 1

/** Entropy of one session id; the id is carried inside the signed cookie payload. */
const SESSION_ID_BYTES = 32

/** Credentials record key holding the registry snapshot beside the cookie signing secret. */
export const SESSION_REGISTRY_RECORD_KEY = credentialKey('client-connection', 'browser-sessions')

/** One durable browser session registered by Connection. */
export interface RegisteredSession {
  /** Opaque random id carried in the signed cookie payload. */
  readonly sessionId: string
  /** Human-readable label assigned when the session was issued. */
  readonly deviceLabel: string
  /** Absolute Unix-millisecond issue time. */
  readonly issuedAt: number
  /** Absolute Unix-millisecond expiry; expired records are dropped. */
  readonly expiresAt: number
  /** Revocation time, or undefined while the session is still valid. */
  readonly revokedAt: number | undefined
}

/** JSON snapshot of the registry, persisted beside the browser-session signing secret. */
export interface StoredSessionRegistry {
  readonly version: typeof STORED_REGISTRY_VERSION
  readonly sessions: readonly RegisteredSession[]
}

/** Durable home of the registry snapshot. */
export interface SessionRegistryStore {
  /**
   * Read the persisted snapshot.
   * @returns the stored snapshot, or undefined while none exists.
   * @throws when the snapshot cannot be read; the registry then starts empty.
   */
  load(): Promise<StoredSessionRegistry | undefined>
  /**
   * Replace the persisted snapshot atomically.
   * @param snapshot - the complete next registry content.
   * @throws when the write fails; the in-memory commit stands and the failure is raised.
   */
  save(snapshot: StoredSessionRegistry): Promise<void>
}

/**
 * Credentials-backed store: the snapshot lives in the
 * `client-connection/browser-sessions` grant record, the same writable source
 * as the cookie signing secret.
 * @param credentials - persistent credential provider for the Harness home.
 * @returns a registry store that reads and atomically replaces that record.
 */
export function credentialSessionRegistryStore(credentials: CredentialProvider): SessionRegistryStore {
  return {
    async load(): Promise<StoredSessionRegistry | undefined> {
      const record = await credentials.readRecord(SESSION_REGISTRY_RECORD_KEY)
      if (record === undefined) return undefined
      if (record.kind !== 'grant' || typeof record.payload !== 'object' || record.payload === null) {
        throw new Error('client-connection: browser-sessions credential record has an unsupported format')
      }
      return record.payload as unknown as StoredSessionRegistry
    },
    async save(snapshot: StoredSessionRegistry): Promise<void> {
      await credentials.modifyRecord(
        SESSION_REGISTRY_RECORD_KEY,
        () => Promise.resolve({ kind: 'grant', payload: snapshot }),
      )
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRegisteredSession(value: unknown): value is RegisteredSession {
  return isRecord(value)
    && typeof value.sessionId === 'string' && value.sessionId !== ''
    && typeof value.deviceLabel === 'string' && value.deviceLabel !== ''
    && Number.isSafeInteger(value.issuedAt)
    && Number.isSafeInteger(value.expiresAt)
    && (value.revokedAt === undefined || Number.isSafeInteger(value.revokedAt))
}

/** Whether a loaded value is a structurally valid snapshot; anything else is corrupt and never trusted. */
function isValidSnapshot(value: unknown): value is StoredSessionRegistry {
  return isRecord(value)
    && value.version === STORED_REGISTRY_VERSION
    && Array.isArray(value.sessions)
    && value.sessions.every(entry => isRegisteredSession(entry))
}

function assertDeviceLabel(deviceLabel: string): void {
  if (typeof deviceLabel !== 'string' || deviceLabel.length === 0) {
    throw new Error('connection: session deviceLabel must be a non-empty string')
  }
}

function assertExpiresAt(expiresAt: number, issuedAt: number): void {
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= issuedAt) {
    throw new Error('connection: session expiresAt must be a safe integer after the issue time')
  }
}

/**
 * In-memory session table with durable persistence. Reads are synchronous
 * because request authentication cannot await: the snapshot is loaded during
 * activation, and every mutation commits to memory before its write. A
 * snapshot that cannot be trusted (unreadable, structurally invalid, or an
 * unsupported version) is discarded and rewritten empty, so every cookie
 * issued before the corruption is rejected — fail closed — while new logins
 * work again without manual repair.
 */
export class SessionRegistry {
  private readonly store: SessionRegistryStore
  private readonly sessions = new Map<string, RegisteredSession>()
  private readonly loadPromise: Promise<void>
  private pendingWrite: Promise<void> = Promise.resolve()
  private persistFailure: { readonly error: unknown } | undefined

  /**
   * Start loading the persisted snapshot. Authentication before the load
   * settles rejects every cookie, because the in-memory table is still empty.
   * @param store - durable home of the registry snapshot.
   */
  constructor(store: SessionRegistryStore) {
    this.store = store
    this.loadPromise = this.load(store)
  }

  /** Resolves once the startup snapshot has been applied; callers that authenticate must await it first. */
  get loaded(): Promise<void> {
    return this.loadPromise
  }

  /**
   * Register a new session and persist it before resolving.
   * @param deviceLabel - label recorded for the new session.
   * @param expiresAt - absolute Unix-millisecond expiry after the issue time.
   * @returns the registered session.
   * @throws when the arguments are invalid, or when the persisted write fails
   * (the session is already registered in memory).
   */
  async issue(deviceLabel: string, expiresAt: number): Promise<RegisteredSession> {
    const session = this.issueSync(deviceLabel, expiresAt)
    await this.writeSnapshot()
    return session
  }

  /**
   * Register a new session synchronously for the index-token exchange, which
   * must complete inside one request tick. The write continues in the
   * background; its failure is latched and rethrown by the next awaited
   * registry operation, so a session that never becomes durable cannot fail
   * silently.
   * @param deviceLabel - label recorded for the new session.
   * @param expiresAt - absolute Unix-millisecond expiry after the issue time.
   * @returns the registered session, already visible to {@link lookup}.
   */
  issueSync(deviceLabel: string, expiresAt: number): RegisteredSession {
    // Surface a previously failed durable write instead of layering new
    // sessions on a registry that may not be persisting at all.
    this.raisePersistFailure()
    const issuedAt = Date.now()
    assertDeviceLabel(deviceLabel)
    assertExpiresAt(expiresAt, issuedAt)
    this.pruneExpired(issuedAt)
    const session: RegisteredSession = {
      sessionId: encodeBase64Url(randomBytes(SESSION_ID_BYTES)),
      deviceLabel,
      issuedAt,
      expiresAt,
      revokedAt: undefined,
    }
    this.sessions.set(session.sessionId, session)
    void this.writeQueued().catch(() => {
      /* the failure is latched and rethrown by the next awaited operation */
    })
    return session
  }

  /**
   * Read one registered session.
   * @param sessionId - the cookie payload's session id.
   * @returns the registration, or undefined when it is unknown (or dropped after expiry).
   */
  get(sessionId: string): Promise<RegisteredSession | undefined> {
    return Promise.resolve(this.lookup(sessionId))
  }

  /**
   * Synchronous read used by request authentication, which cannot await.
   * @param sessionId - the cookie payload's session id.
   * @returns the registration, or undefined when unknown.
   */
  lookup(sessionId: string): RegisteredSession | undefined {
    return this.sessions.get(sessionId)
  }

  /**
   * Revoke one registered session.
   * @param sessionId - the registration to revoke.
   * @returns false when the session is unknown or already revoked; true after
   * this call revoked it. The in-memory revocation stands even when the
   * persisted write fails and the failure is raised.
   */
  async revoke(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (session === undefined || session.revokedAt !== undefined) return false
    this.sessions.set(sessionId, { ...session, revokedAt: Date.now() })
    await this.writeSnapshot()
    return true
  }

  /**
   * List every registration, including revoked and not-yet-expired ones.
   * @returns the registrations in issue order; no cookie material is part of a registration.
   */
  list(): Promise<readonly RegisteredSession[]> {
    return Promise.resolve([...this.sessions.values()])
  }

  /**
   * Settle every queued snapshot write and rethrow a latched background write
   * failure. Test and tooling helper for deterministic persistence.
   */
  async flush(): Promise<void> {
    await this.pendingWrite
    this.raisePersistFailure()
  }

  private async load(store: SessionRegistryStore): Promise<void> {
    let stored: StoredSessionRegistry | undefined
    let corrupt = false
    try {
      const loaded = await store.load()
      if (loaded === undefined) return
      if (isValidSnapshot(loaded)) stored = loaded
      else corrupt = true
    } catch {
      corrupt = true
    }
    const now = Date.now()
    for (const session of stored?.sessions ?? []) {
      if (session.expiresAt > now) this.sessions.set(session.sessionId, session)
    }
    if (corrupt) {
      // Fail closed: an untrustworthy snapshot is discarded and rewritten
      // empty, so every cookie issued before the corruption is rejected.
      void this.writeQueued().catch(() => {
        /* the failure is latched and rethrown by the next awaited operation */
      })
    }
  }

  private pruneExpired(now: number): void {
    for (const [sessionId, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(sessionId)
    }
  }

  private snapshot(): StoredSessionRegistry {
    return { version: STORED_REGISTRY_VERSION, sessions: [...this.sessions.values()] }
  }

  /** Queue one snapshot write after all earlier writes; earlier failures do not cancel later ones. */
  private writeQueued(): Promise<void> {
    const run = this.pendingWrite.then(() => this.store.save(this.snapshot()))
    this.pendingWrite = run.then(() => undefined, (error: unknown) => {
      this.persistFailure ??= { error }
    })
    return run
  }

  /** Run one awaited snapshot write, first rethrowing any latched background failure. */
  private async writeSnapshot(): Promise<void> {
    this.raisePersistFailure()
    try {
      await this.writeQueued()
    } finally {
      this.persistFailure = undefined
    }
  }

  private raisePersistFailure(): void {
    if (this.persistFailure === undefined) return
    const failure = this.persistFailure
    this.persistFailure = undefined
    throw failure.error
  }
}
