/** Device-token registry persisted atomically inside the registry directory. */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { DeviceRegistration, PushRegistrationRequest, StoredRegistry } from './types.ts'

const REGISTRY_FILENAME = 'devices.json'

/** Failure raised for unreadable or malformed registry files. */
export class RegistryStoreError extends Error {
  /**
   * @param message - human-readable failure description.
   * @param cause - the underlying read or parse failure.
   */
  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'RegistryStoreError'
    if (cause !== undefined) this.cause = cause
  }
}

/** Cross-process-safe store for the device registry. */
export class RegistryStore {
  /** Absolute path of the backing JSON document. */
  readonly path: string

  /**
   * @param directory - absolute registry directory.
   * @param now - host clock used to stamp registration times.
   */
  constructor(directory: string, private readonly now: () => number = Date.now) {
    this.path = join(directory, REGISTRY_FILENAME)
  }

  /**
   * Add or replace one device registration.
   * @param req - authenticated registration request without a timestamp.
   * @returns completion once the registry document is committed.
   */
  async register(req: Omit<DeviceRegistration, 'registeredAt'>): Promise<void> {
    await this.mutate((devices) => {
      const others = devices.filter(device => device.deviceId !== req.deviceId)
      return [...others, { ...req, registeredAt: this.now() }]
    })
  }

  /**
   * Remove one device registration.
   * @param deviceId - device to remove.
   * @returns whether a registration was removed.
   */
  async unregister(deviceId: string): Promise<boolean> {
    let removed = false
    await this.mutate((devices) => {
      const kept = devices.filter((device) => {
        if (device.deviceId !== deviceId) return true
        removed = true
        return false
      })
      return kept
    })
    return removed
  }

  /**
   * Read every registration.
   * @returns all stored registrations, including tokens.
   */
  async list(): Promise<readonly DeviceRegistration[]> {
    return (await this.load()).devices
  }

  /** Read-modify-write the registry document under the cross-process file lock. */
  private async mutate(apply: (devices: readonly DeviceRegistration[]) => DeviceRegistration[]): Promise<void> {
    await withFileLock(`${this.path}.lock`, async () => {
      const current = await this.load()
      const next: StoredRegistry = { devices: apply(current.devices) }
      await writeFileAtomic(this.path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
    })
  }

  /** Load and validate the registry document; a missing file is an empty registry. */
  private async load(): Promise<StoredRegistry> {
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      if (isNotFound(error)) return { devices: [] }
      throw new RegistryStoreError(`push-registry: registry document ${this.path} is unreadable`, error)
    }
    return parseRegistry(text, this.path)
  }
}

/** Whether one read failure means the registry document does not exist yet. */
function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

/**
 * Parse and validate one registry document. Tokens are secrets, so every
 * validation failure names the file, never the content.
 * @param text - raw document text.
 * @param path - document path used in failure messages.
 * @returns the stored registry.
 * @throws RegistryStoreError when the document is not a valid registry.
 */
export function parseRegistry(text: string, path: string): StoredRegistry {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new RegistryStoreError(`push-registry: registry document ${path} is not valid JSON`, error)
  }
  if (typeof value !== 'object' || value === null || !Array.isArray((value as Record<string, unknown>).devices)) {
    throw new RegistryStoreError(`push-registry: registry document ${path} must hold a devices array`)
  }
  const devices = ((value as Record<string, unknown>).devices as unknown[]).map(device => parseDevice(device, path))
  return { devices }
}

/** Validate one stored registration record. */
function parseDevice(value: unknown, path: string): DeviceRegistration {
  if (typeof value !== 'object' || value === null) {
    throw new RegistryStoreError(`push-registry: registry document ${path} holds a malformed device entry`)
  }
  const device = value as Record<string, unknown>
  if (typeof device.deviceId !== 'string' || device.deviceId.length === 0
    || typeof device.platform !== 'string' || device.platform.length === 0
    || typeof device.token !== 'string' || device.token.length === 0
    || typeof device.registeredAt !== 'number' || !Number.isSafeInteger(device.registeredAt)) {
    throw new RegistryStoreError(`push-registry: registry document ${path} holds a malformed device entry`)
  }
  return {
    deviceId: device.deviceId,
    platform: device.platform,
    token: device.token,
    registeredAt: device.registeredAt,
  }
}

/**
 * Validate one wire-supplied registration request. Device ids and tokens cross
 * the connection, so they are checked at the service instead of trusted from
 * the static interface.
 * @param req - request as received over the wire.
 * @returns the validated registration value without a timestamp.
 * @throws Error when a field is missing or empty.
 */
export function parseRegistrationRequest(req: PushRegistrationRequest): Omit<DeviceRegistration, 'registeredAt'> {
  const value: unknown = req
  if (typeof value !== 'object' || value === null) {
    throw new Error('push-registry: registration requires deviceId, platform, and token')
  }
  const fields = value as Record<string, unknown>
  if (typeof fields.deviceId !== 'string' || fields.deviceId.length === 0) {
    throw new Error('push-registry: deviceId must be a non-empty string')
  }
  if (fields.platform !== 'ios') {
    throw new Error('push-registry: only the ios platform is supported')
  }
  if (typeof fields.token !== 'string' || fields.token.length === 0) {
    throw new Error('push-registry: token must be a non-empty string')
  }
  return { deviceId: fields.deviceId, platform: 'ios', token: fields.token }
}

/**
 * Validate one wire-supplied device identifier.
 * @param req - removal request as received over the wire.
 * @returns the validated device id.
 * @throws Error when the id is missing or empty.
 */
export function parseDeviceId(req: { deviceId: string }): string {
  const value: unknown = req
  if (typeof value !== 'object' || value === null) {
    throw new Error('push-registry: deviceId must be a non-empty string')
  }
  const fields = value as Record<string, unknown>
  if (typeof fields.deviceId !== 'string' || fields.deviceId.length === 0) {
    throw new Error('push-registry: deviceId must be a non-empty string')
  }
  return fields.deviceId
}
