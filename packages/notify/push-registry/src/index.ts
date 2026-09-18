/** Push registry Remote owner: device registration plus session-event outbound delivery. */

import { mkdirSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-user-approval/types'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { resolvePushRegistryConfig } from './config.ts'
import { NotificationGate } from './dedupe.ts'
import { DeliveryLog } from './delivery-log.ts'
import { awaitingConfirmationEvent, turnFailedEvent, turnFinishedEvent } from './events.ts'
import { runOutbound } from './outbound.ts'
import { RegistryStore, parseDeviceId, parseRegistrationRequest } from './registry-store.ts'
import type {
  DeliveryRecord,
  DeviceRegistration,
  DeviceView,
  NotificationEvent,
  PushRegistryConfig,
  PushRegistrationRequest,
  ResolvedPushRegistryConfig,
} from './types.ts'

export * from './types.ts'
export {
  DEFAULT_DEDUPE_WINDOW_MS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_OUTBOUND_TIMEOUT_MS,
  resolvePushRegistryConfig,
} from './config.ts'
export { RegistryStoreError } from './registry-store.ts'

/** Host integrations replaceable by direct unit tests. */
export interface PushRegistryInternals {
  /** Host clock used for event times, registration stamps, and dedupe windows. */
  readonly now?: () => number
  /** Inter-attempt wait; defaults to the fixed exponential backoff. */
  readonly sleep?: (ms: number) => Promise<void>
}

/**
 * Opt-in APNs notification registry. Registered devices receive sanitized,
 * title-level notifications through the configured outbound command; without
 * one the service only registers devices. Device tokens live in the registry
 * document alone and never enter logs or delivery records.
 */
export class PushRegistry extends TypertRemoteService {
  static Config = z.object({
    registryDirectory: z.string().required(),
    // Absent must stay absent: the register-only mode is `undefined`, not an empty argv.
    outboundCommand: z.array(z.string()).default(undefined as unknown as string[]),
    outboundTimeoutMs: z.number(),
    dedupeWindowMs: z.number(),
    maxRetries: z.number(),
  }) as unknown as z<PushRegistryConfig>

  /** Validated deployment configuration every delivery runs under. */
  private readonly config: ResolvedPushRegistryConfig
  /** Device registry backed by `registryDirectory/devices.json`. */
  private readonly store: RegistryStore
  /** Delivery log backed by `registryDirectory/deliveries.jsonl`. */
  private readonly log: DeliveryLog
  /** Dedupe and failure-dominance gate. */
  private readonly gate: NotificationGate
  /** In-flight delivery fan-outs awaited at disposal. */
  private readonly inFlight = new Set<Promise<void>>()
  /** Inter-attempt wait override handed to every delivery. */
  private readonly sleep: ((ms: number) => Promise<void>) | undefined

  /**
   * @param ctx - host context carrying the Typert gateway binding.
   * @param config - deployment configuration.
   * @param internals - host integrations replaceable by direct unit tests.
   */
  constructor(ctx: Context, config: PushRegistryConfig, internals: PushRegistryInternals = {}) {
    super(ctx, 'pushRegistry', { namespace: 'pushRegistry' })
    this.config = resolvePushRegistryConfig(config)
    const now = internals.now ?? Date.now
    this.sleep = internals.sleep
    mkdirSync(this.config.registryDirectory, { recursive: true })
    this.store = new RegistryStore(this.config.registryDirectory, now)
    this.log = new DeliveryLog(this.config.registryDirectory)
    this.gate = new NotificationGate(this.config.dedupeWindowMs, now)

    ctx.effect(() => async () => {
      await this.drain()
    }, 'push-registry: drain in-flight deliveries')

    ctx.on('api-session/status', (sessionId, running) => {
      if (running) return
      this.enqueue(turnFinishedEvent(sessionId, now()))
    })
    ctx.on('api-session/error', (sessionId) => {
      // The emitted error message quotes error chains; the notification stays title-only.
      this.enqueue(turnFailedEvent(sessionId, now()))
    })
    ctx.on('approval/request', (request, next) => {
      this.enqueue(awaitingConfirmationEvent(request.agent.id, request.toolName, now()))
      return next()
    })
  }

  /**
   * Register or refresh one device. Authentication comes from the connection
   * layer; the token is persisted to the registry document and never logged.
   * @param req - registration request received over the wire.
   * @throws Error when a request field is missing, empty, or unsupported.
   */
  @Remote
  async register(req: PushRegistrationRequest): Promise<void> {
    const value = parseRegistrationRequest(req)
    await this.store.register(value)
  }

  /**
   * Remove one device registration.
   * @param req - device identifier to remove.
   * @returns whether a registration was removed.
   * @throws Error when the device id is missing or empty.
   */
  @Remote
  async unregister(req: { deviceId: string }): Promise<boolean> {
    return this.store.unregister(parseDeviceId(req))
  }

  /**
   * List registered devices. Tokens are secret, so views omit them.
   * @returns every registration without tokens.
   */
  @Remote
  async list(): Promise<readonly DeviceView[]> {
    const devices = await this.store.list()
    return devices.map(device => viewOf(device))
  }

  /** Await every in-flight delivery fan-out. */
  private async drain(): Promise<void> {
    await Promise.allSettled([...this.inFlight])
  }

  /**
   * Admit one event through the gate and fan it out to every registered
   * device. Register-only mode never spawns.
   */
  private enqueue(event: NotificationEvent): void {
    if (this.config.outboundCommand === undefined) return
    if (!this.gate.admit(event)) return
    this.gate.record(event)
    if (event.kind === 'turn-failed') this.gate.markTurnFailed(event.sessionId)
    const task = this.deliverToAll(event)
    this.inFlight.add(task)
    void task.finally(() => {
      this.inFlight.delete(task)
    })
  }

  /** Deliver one event to every registered device and record each result. */
  private async deliverToAll(event: NotificationEvent): Promise<void> {
    const command = this.config.outboundCommand as readonly string[]
    const devices = await this.store.list()
    await Promise.all(devices.map(async (device) => {
      const outcome = await runOutbound(
        { event, device: { deviceId: device.deviceId, platform: device.platform, token: device.token } },
        command,
        { timeoutMs: this.config.outboundTimeoutMs, maxRetries: this.config.maxRetries,
          ...(this.sleep === undefined ? {} : { sleep: this.sleep }) },
      )
      const record: DeliveryRecord = {
        sessionId: event.sessionId,
        kind: event.kind,
        deviceId: device.deviceId,
        outcome: outcome.ok ? 'delivered' : 'failed',
        attempts: outcome.attempts,
        durationMs: outcome.durationMs,
        at: Date.now(),
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
      }
      await this.log.append(record)
    }))
  }
}

/** Strip the token from one stored registration. */
function viewOf(device: DeviceRegistration): DeviceView {
  return { deviceId: device.deviceId, platform: device.platform, registeredAt: device.registeredAt }
}

export default PushRegistry
