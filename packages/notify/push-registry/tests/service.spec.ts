/**
 * Service behavior: session-event subscription, per-device delivery fan-out,
 * sanitization of the outbound payload, the dedupe window and failure
 * dominance at the service level, the register-only mode, disposal draining,
 * and the real-Loader composition of the opt-in plugin.
 * @module service.spec
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent/types'
import PushRegistry from '../src/index.ts'
import type { PushRegistryInternals } from '../src/index.ts'
import type { OutboundPayload, PushRegistryConfig } from '../src/types.ts'

const recordStdin = fileURLToPath(new URL('./fixtures/record-stdin.mjs', import.meta.url))
/** Fixed host clock so registration stamps and event times assert exactly. */
const FIXED_NOW = 1_000_000
const failFast = fileURLToPath(new URL('./fixtures/fail-fast.mjs', import.meta.url))

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Build one booted service over a fresh registry directory. */
async function makeService(
  overrides: Partial<PushRegistryConfig> = {},
  script: string | undefined = recordStdin,
  internals: PushRegistryInternals = {},
): Promise<{ service: PushRegistry; directory: string; deliveries: string; calls: string }> {
  const base = await mkdtemp(join(tmpdir(), 'push-registry-service-'))
  root = base
  context = new Context()
  const directory = join(base, 'registry')
  const deliveries = join(directory, 'deliveries.jsonl')
  const calls = join(base, 'calls.jsonl')
  const service = new PushRegistry(context, {
    registryDirectory: directory,
    ...(script === undefined ? {} : { outboundCommand: [process.execPath, script, calls] }),
    outboundTimeoutMs: 5000,
    dedupeWindowMs: 60_000,
    maxRetries: 2,
    ...overrides,
  }, { now: () => FIXED_NOW, ...internals })
  return { service, directory, deliveries, calls }
}

/** Register two devices through the Remote surface. */
async function registerTwoDevices(service: PushRegistry): Promise<void> {
  await service.register({ deviceId: 'phone-1', platform: 'ios', token: 'token-1' })
  await service.register({ deviceId: 'phone-2', platform: 'ios', token: 'token-2' })
}

/** Wait until the delivery log holds exactly `count` records. */
async function waitForDeliveries(deliveries: string, count: number): Promise<string[]> {
  return vi.waitFor(async () => {
    const text = await readFile(deliveries, 'utf8').catch(() => '')
    const lines = text.split('\n').filter(line => line.length > 0)
    expect(lines).toHaveLength(count)
    return lines
  }, { timeout: 5000, interval: 20 })
}

/** Wait until the fake command has recorded exactly `count` payloads. */
async function waitForCalls(calls: string, count: number): Promise<OutboundPayload[]> {
  return vi.waitFor(async () => {
    const text = await readFile(calls, 'utf8').catch(() => '')
    const lines = text.split('\n').filter(line => line.length > 0)
    expect(lines).toHaveLength(count)
    return lines.map(line => JSON.parse(line) as OutboundPayload)
  }, { timeout: 5000, interval: 20 })
}

describe('PushRegistry Remote surface', () => {
  it('registers, lists without tokens, and unregisters', async () => {
    const { service } = await makeService()
    await registerTwoDevices(service)

    await expect(service.list()).resolves.toEqual([
      { deviceId: 'phone-1', platform: 'ios', registeredAt: FIXED_NOW },
      { deviceId: 'phone-2', platform: 'ios', registeredAt: FIXED_NOW },
    ])

    await expect(service.unregister({ deviceId: 'phone-1' })).resolves.toBe(true)
    await expect(service.unregister({ deviceId: 'phone-1' })).resolves.toBe(false)
    await expect(service.list()).resolves.toHaveLength(1)
  })

  it('rejects malformed registration and removal requests', async () => {
    const { service } = await makeService()

    await expect(service.register(null as never)).rejects.toThrow('registration requires')
    await expect(service.register({ deviceId: '', platform: 'ios', token: 't' })).rejects.toThrow('deviceId')
    await expect(service.register({ deviceId: 'p', platform: 'android' as never, token: 't' })).rejects.toThrow('ios')
    await expect(service.register({ deviceId: 'p', platform: 'ios', token: '' })).rejects.toThrow('token')
    await expect(service.unregister({ deviceId: '' })).rejects.toThrow('deviceId')
    await expect(service.unregister(null as never)).rejects.toThrow('deviceId')
  })

  it('keeps registrations and the delivery log across a service restart', async () => {
    const { service, directory } = await makeService()
    await registerTwoDevices(service)
    await service.unregister({ deviceId: 'phone-1' })
    await context!.fiber.dispose()
    context = undefined

    const restarted = new Context()
    context = restarted
    const revived = new PushRegistry(restarted, {
      registryDirectory: directory,
      outboundTimeoutMs: 5000,
      maxRetries: 2,
    })
    await expect(revived.list()).resolves.toHaveLength(1)
    await revived.register({ deviceId: 'phone-2', platform: 'ios', token: 'token-2' })
    await expect(revived.list()).resolves.toHaveLength(1)
  })
})

describe('PushRegistry event subscription', () => {
  it('delivers one sanitized payload per registered device when a turn finishes', async () => {
    const { service, deliveries, calls } = await makeService()
    await registerTwoDevices(service)

    context!.emit('api-session/status', SessionId('session-1'), true)
    context!.emit('api-session/status', SessionId('session-1'), false)
    const payloads = await waitForCalls(calls, 2)

    expect(payloads.map(item => item.device.deviceId).sort()).toEqual(['phone-1', 'phone-2'])
    expect(payloads[1]).toEqual({
      event: { kind: 'turn-finished', sessionId: 'session-1', title: 'Turn finished', occurredAt: FIXED_NOW },
      device: { deviceId: payloads[1]!.device.deviceId, platform: 'ios', token: payloads[1]!.device.token },
    })
    const records = (await waitForDeliveries(deliveries, 2)).map(line => JSON.parse(line) as Record<string, unknown>)
    expect(records.map(record => record.outcome)).toEqual(['delivered', 'delivered'])
  })

  it('suppresses the second event of one kind inside the dedupe window', async () => {
    const { service, calls } = await makeService()
    await registerTwoDevices(service)

    context!.emit('api-session/status', SessionId('session-1'), false)
    await waitForCalls(calls, 2)
    context!.emit('api-session/status', SessionId('session-1'), false)
    // A fresh session passes the gate, so its deliveries prove the suppressed
    // event was evaluated and dropped; no further records may appear.
    context!.emit('api-session/status', SessionId('session-2'), false)
    const payloads = await waitForCalls(calls, 4)

    expect(payloads.map(item => item.event.sessionId))
      .toEqual(['session-1', 'session-1', 'session-2', 'session-2'])
    await expect(readFile(calls, 'utf8').then(text => text.split('\n').filter(Boolean))).resolves.toHaveLength(4)
  })

  it('delivers turn failures and suppresses the paired finished notification', async () => {
    const { service, calls } = await makeService()
    await registerTwoDevices(service)

    context!.emit('api-session/error', SessionId('session-1'), 'provider unreachable')
    await waitForCalls(calls, 2)
    context!.emit('api-session/status', SessionId('session-1'), false)
    // session-2's finish proves the suppressed event was evaluated and dropped.
    context!.emit('api-session/status', SessionId('session-2'), false)
    const payloads = await waitForCalls(calls, 4)

    expect(payloads.map(item => [item.event.sessionId, item.event.kind])).toEqual([
      ['session-1', 'turn-failed'],
      ['session-1', 'turn-failed'],
      ['session-2', 'turn-finished'],
      ['session-2', 'turn-finished'],
    ])
  })

  it('notifies awaiting-confirmation without claiming the approval waterfall', async () => {
    const { service, calls } = await makeService()
    await registerTwoDevices(service)
    const agent = { id: SessionId('session-1') } as Agent

    const outcome = await context!.waterfall('approval/request', {
      agent,
      toolName: 'bash',
    }, async () => 'allowed-once' as const)

    expect(outcome).toBe('allowed-once')
    const payloads = await waitForCalls(calls, 2)
    expect(payloads[0]!.event).toMatchObject({ kind: 'awaiting-confirmation', title: 'Approval needed: bash' })
  })

  it('retries a failing command and records the failed delivery', async () => {
    const { service, deliveries } = await makeService({}, failFast)
    await service.register({ deviceId: 'phone-1', platform: 'ios', token: 'token-1' })

    context!.emit('api-session/status', SessionId('session-1'), false)
    const records = (await waitForDeliveries(deliveries, 1)).map(line => JSON.parse(line) as Record<string, unknown>)

    expect(records[0]).toMatchObject({
      sessionId: 'session-1',
      kind: 'turn-finished',
      deviceId: 'phone-1',
      outcome: 'failed',
      attempts: 3,
      error: 'exited with code 1',
    })
    expect(typeof records[0]!.durationMs).toBe('number')
  })

  it('waits with the injected backoff between retry attempts', async () => {
    const waits: number[] = []
    const { service, deliveries } = await makeService({}, failFast, {
      sleep: async (ms) => {
        waits.push(ms)
      },
    })
    await service.register({ deviceId: 'phone-1', platform: 'ios', token: 'token-1' })

    context!.emit('api-session/error', SessionId('session-1'), 'provider unreachable')
    await waitForDeliveries(deliveries, 1)

    expect(waits).toEqual([250, 500])
  })

  it('never spawns in register-only mode', async () => {
    const { service, calls } = await makeService({ outboundCommand: undefined })
    await service.register({ deviceId: 'phone-1', platform: 'ios', token: 'token-1' })

    context!.emit('api-session/status', SessionId('session-1'), false)
    context!.emit('api-session/error', SessionId('session-1'), 'provider unreachable')
    await service.unregister({ deviceId: 'phone-1' })
    // Disposal awaits in-flight fan-outs, so any spawn these two events could
    // have started has settled before the assertion below.
    await context!.fiber.dispose()
    context = undefined

    await expect(readFile(calls, 'utf8')).rejects.toThrow('ENOENT')
  })

  it('never writes a token into the delivery log', async () => {
    const { service, deliveries } = await makeService()
    await service.register({ deviceId: 'phone-1', platform: 'ios', token: 'secret-token-value' })

    context!.emit('api-session/status', SessionId('session-1'), false)
    await waitForDeliveries(deliveries, 1)

    const log = await readFile(deliveries, 'utf8')
    expect(log).not.toContain('secret-token-value')
  })
})

describe('real-Loader composition', () => {
  it('boots the opt-in plugin from one cordis.yml', { timeout: 30_000 }, async () => {
    const base = await mkdtemp(join(tmpdir(), 'push-registry-composition-'))
    root = base
    const configPath = join(base, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-push-registry'",
      '  config:',
      `    registryDirectory: '${join(base, 'registry')}'`,
      '    outboundTimeoutMs: 5000',
      '    dedupeWindowMs: 60000',
      '    maxRetries: 2',
      '',
    ].join('\n'))
    const booted = new Context()
    context = booted
    booted.baseUrl = `${pathToFileURL(base).href}/`
    await booted.plugin(Loader)
    booted.loader.builtins.include = Include
    booted.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (specifier === '@deepseek-ai/dsh-push-registry') return import('../src/index.ts')
        throw new Error(`unexpected Loader import: ${specifier}`)
      },
    } as unknown as NonNullable<typeof booted.loader.internal>
    await booted.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await booted.loader.await()

    const service = booted.get('pushRegistry') as PushRegistry
    await service.register({ deviceId: 'phone-1', platform: 'ios', token: 'token-1' })
    const devices = await service.list()
    expect(devices.map(device => [device.deviceId, device.platform, device.registeredAt > 0]))
      .toEqual([['phone-1', 'ios', true]])
  })
})
