/**
 * The global integration mutex: `<experimentsRoot>/integration.lock`. Only
 * one integration may run against one experiments root at a time, because
 * rebases and fast-forwards against one project baseline are serial. The lock
 * file records the holding pid; a lock whose pid no longer names a live
 * process is stale and is removed by the next acquirer, but only while the
 * file still holds the content that was judged stale. A live holder is
 * waited for, never preempted.
 * @module @deepseek-ai/dsh-workflow-self-development-workspaces/integration-lock
 */

import { mkdir, open, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { SelfDevelopmentWorkspacesError } from './runtime.ts'

/** Poll interval while waiting for a live lock holder. */
const POLL_MS = 50

/** Upper bound on waiting for one live holder before giving up. */
const DEFAULT_MAX_WAIT_MS = 60_000

/** Optional bounds for one lock acquisition. */
export interface LockOptions {
  /** Upper bound on waiting for one live holder; defaults to one minute. */
  readonly maxWaitMs?: number
}

/**
 * The integration lock path for an experiments root.
 * @param experimentsRoot - absolute experiments root.
 * @returns the absolute lock path.
 */
export function integrationLockPath(experimentsRoot: string): string {
  return join(experimentsRoot, 'integration.lock')
}

/**
 * Whether a pid names a live process. `EPERM` counts as alive: the process
 * exists but is owned by another user.
 * @param pid - numeric pid from a lock file.
 * @returns true when the process is alive.
 */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * The lock record this service writes.
 * @param acquiredAt - wall-clock milliseconds of acquisition.
 * @returns the encoded lock record.
 */
function lockRecord(acquiredAt: number): string {
  return `${JSON.stringify({ pid: process.pid, acquiredAt })}\n`
}

/**
 * Try once to create the lock file exclusively.
 * @param lockPath - absolute lock path.
 * @returns true when this call now holds the lock.
 */
async function tryAcquire(lockPath: string): Promise<boolean> {
  try {
    const handle = await open(lockPath, 'wx')
    try {
      await handle.writeFile(lockRecord(Date.now()), 'utf8')
    } finally {
      await handle.close()
    }
    return true
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') return false
    throw error
  }
}

/**
 * Read an existing lock file's raw content.
 * @param lockPath - absolute lock path.
 * @returns the file content, or `undefined` when the file is missing or
 *   unreadable (an unreadable lock is treated as stale).
 */
async function readLockRecord(lockPath: string): Promise<string | undefined> {
  try {
    return (await readFile(lockPath)).toString('utf8')
  } catch {
    return undefined
  }
}

/**
 * Extract the pid recorded in a lock file's content.
 * @param record - the raw lock file content.
 * @returns the recorded pid, or `undefined` when the content holds no numeric
 *   pid (unparseable content is stale by definition).
 */
function lockRecordPid(record: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(record)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const pid = (parsed as { pid?: unknown }).pid
    return typeof pid === 'number' ? pid : undefined
  } catch {
    // Unparseable lock content is stale by definition.
    return undefined
  }
}

/**
 * Run `fn` while holding the experiments root's integration lock. A live
 * holder is waited for up to `options.maxWaitMs` (one minute by default); a
 * stale holder — a pid that no longer names a live process, or an unreadable
 * lock file — is removed and the lock taken. A stale verdict is re-checked
 * against the file's content before the removal, so a lock that a racing
 * acquirer recreated between the two reads is waited for, not deleted. The
 * lock is always released when `fn` settles, including on throw.
 * @typeParam T - result of the serialized work.
 * @param experimentsRoot - absolute experiments root owning the lock.
 * @param fn - the serialized work.
 * @param options - wait bounds; hosts omit it and take the default.
 * @returns whatever `fn` resolves with.
 * @throws SelfDevelopmentWorkspacesError with `SELF_DEV_WORKSPACE_INTEGRATION_BUSY` when a
 *   live holder does not release within the wait bound; any filesystem failure
 *   outside the stale-retry loop propagates verbatim.
 */
export async function withIntegrationLock<T>(
  experimentsRoot: string,
  fn: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const lockPath = integrationLockPath(experimentsRoot)
  await mkdir(experimentsRoot, { recursive: true })
  const deadline = Date.now() + (options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS)
  for (;;) {
    if (await tryAcquire(lockPath)) break
    const record = await readLockRecord(lockPath)
    const holder = record === undefined ? undefined : lockRecordPid(record)
    if (holder === undefined || !pidAlive(holder)) {
      // Stale: remove and retry immediately — but only the exact record just
      // judged stale. A racing acquirer may have replaced the file between the
      // two reads; the exclusive create then sorts the rest out.
      if (await readLockRecord(lockPath) === record) await rm(lockPath, { force: true })
      continue
    }
    if (Date.now() >= deadline) {
      throw new SelfDevelopmentWorkspacesError(
        `integration lock ${lockPath} is held by live process ${String(holder)}`,
        'SELF_DEV_WORKSPACE_INTEGRATION_BUSY',
      )
    }
    await new Promise(resolve => setTimeout(resolve, POLL_MS))
  }
  try {
    return await fn()
  } finally {
    await rm(lockPath, { force: true })
  }
}
