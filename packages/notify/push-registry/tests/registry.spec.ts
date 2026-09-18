/**
 * Registry persistence and Remote behavior: atomic device-token storage,
 * restart survival, token-free listing, malformed-document failures, and the
 * wire validation of registration requests.
 * @module registry.spec
 */

import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RegistryStore, RegistryStoreError, parseRegistrationRequest } from '../src/registry-store.ts'
import type { StoredRegistry } from '../src/types.ts'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** One fresh registry directory with a fixed clock. */
async function makeStore(): Promise<{ store: RegistryStore; directory: string }> {
  root = await mkdtemp(join(tmpdir(), 'push-registry-store-'))
  return { store: new RegistryStore(root, () => 1000), directory: root }
}

describe('RegistryStore', () => {
  it('stores registrations atomically and survives a restart', async () => {
    const { store, directory } = await makeStore()

    await store.register({ deviceId: 'phone-1', platform: 'ios', token: 'token-a' })
    await store.register({ deviceId: 'phone-2', platform: 'ios', token: 'token-b' })
    await store.register({ deviceId: 'phone-1', platform: 'ios', token: 'token-c' })

    const stored = JSON.parse(await readFile(join(directory, 'devices.json'), 'utf8')) as StoredRegistry
    expect(stored.devices).toEqual([
      { deviceId: 'phone-2', platform: 'ios', token: 'token-b', registeredAt: 1000 },
      { deviceId: 'phone-1', platform: 'ios', token: 'token-c', registeredAt: 1000 },
    ])

    const restarted = new RegistryStore(directory, () => 1000)
    await expect(restarted.list()).resolves.toHaveLength(2)
    expect(await readdir(directory)).toEqual(['devices.json'])
  })

  it('restricts the registry document to its owner', async () => {
    if (process.platform === 'win32') return
    const { store, directory } = await makeStore()

    await store.register({ deviceId: 'phone-1', platform: 'ios', token: 'token-a' })

    const { mode } = await stat(join(directory, 'devices.json'))
    expect(mode & 0o777).toBe(0o600)
  })

  it('removes a registration once and reports the second removal', async () => {
    const { store } = await makeStore()
    await store.register({ deviceId: 'phone-1', platform: 'ios', token: 'token-a' })

    await expect(store.unregister('phone-1')).resolves.toBe(true)
    await expect(store.unregister('phone-1')).resolves.toBe(false)
    await expect(store.list()).resolves.toEqual([])
  })

  it('treats a missing registry document as an empty registry', async () => {
    const { store } = await makeStore()
    await expect(store.list()).resolves.toEqual([])
  })

  it('fails loud on unreadable and malformed registry documents', async () => {
    const { store, directory } = await makeStore()
    await writeFile(join(directory, 'devices.json'), 'not json', 'utf8')
    await expect(store.list()).rejects.toBeInstanceOf(RegistryStoreError)

    await writeFile(join(directory, 'devices.json'), '{"devices": {}}', 'utf8')
    await expect(store.list()).rejects.toThrow('must hold a devices array')

    await writeFile(join(directory, 'devices.json'), '{"devices": [{}]}', 'utf8')
    await expect(store.list()).rejects.toThrow('malformed device entry')

    await writeFile(join(directory, 'devices.json'), '{"devices": [null]}', 'utf8')
    await expect(store.list()).rejects.toThrow('malformed device entry')

    await writeFile(join(directory, 'devices.json'),
      '{"devices": [{"deviceId": "p", "platform": "ios", "token": "t", "registeredAt": 1.5}]}', 'utf8')
    await expect(store.list()).rejects.toThrow('malformed device entry')

    await rm(join(directory, 'devices.json'), { force: true })
    await mkdir(join(directory, 'devices.json'))
    await expect(store.list()).rejects.toBeInstanceOf(RegistryStoreError)
  })
})

describe('parseRegistrationRequest', () => {
  it('accepts a well-formed iOS registration', () => {
    expect(parseRegistrationRequest({ deviceId: 'phone-1', platform: 'ios', token: 'token-a' }))
      .toEqual({ deviceId: 'phone-1', platform: 'ios', token: 'token-a' })
  })

  it('rejects malformed wire requests', () => {
    expect(() => parseRegistrationRequest(null as never)).toThrow('registration requires')
    expect(() => parseRegistrationRequest({ deviceId: '', platform: 'ios', token: 't' })).toThrow('deviceId')
    expect(() => parseRegistrationRequest({ deviceId: 'p', platform: 'android' as never, token: 't' })).toThrow('ios')
    expect(() => parseRegistrationRequest({ deviceId: 'p', platform: 'ios', token: '' })).toThrow('token')
  })
})
