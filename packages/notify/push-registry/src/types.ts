/** Wire-safe notification vocabulary for the push-registry package. */

/**
 * The session-controller occurrences the registry turns into notifications.
 * Source events: `api-session/status` (running → false), `api-session/error`,
 * and the `approval/request` waterfall.
 */
export type NotificationKind = 'turn-finished' | 'turn-failed' | 'awaiting-confirmation'

/**
 * One sanitized notification. The payload never carries a message body, a
 * filesystem path, or tool arguments: `title` is a fixed per-kind string, plus
 * the asked-for tool name for `awaiting-confirmation`.
 */
export interface NotificationEvent {
  /** Which session-controller occurrence produced the notification. */
  readonly kind: NotificationKind
  /** Session the occurrence belongs to. */
  readonly sessionId: string
  /** Title-level notification text; no message content. */
  readonly title: string
  /** Host-clock milliseconds when the occurrence was observed. */
  readonly occurredAt: number
}

/** Deployment configuration for the push-registry service. */
export interface PushRegistryConfig {
  /** Absolute directory holding the device-token registry and delivery log. */
  readonly registryDirectory: string
  /**
   * Outbound command argv. `undefined` registers devices without ever
   * spawning a delivery; the event JSON arrives on the command's stdin.
   */
  readonly outboundCommand?: readonly string[] | undefined
  /** Per-attempt outbound deadline in milliseconds. */
  readonly outboundTimeoutMs?: number | undefined
  /** Window in which one session emits one notification per kind. */
  readonly dedupeWindowMs?: number | undefined
  /** Retry attempts after the first failure, with exponential backoff. */
  readonly maxRetries?: number | undefined
}

/** Validated deployment configuration every delivery runs under. */
export interface ResolvedPushRegistryConfig {
  /** Absolute directory holding the device-token registry and delivery log. */
  readonly registryDirectory: string
  /** Outbound command argv, or `undefined` for register-only mode. */
  readonly outboundCommand: readonly string[] | undefined
  /** Per-attempt outbound deadline in milliseconds. */
  readonly outboundTimeoutMs: number
  /** Window in which one session emits one notification per kind. */
  readonly dedupeWindowMs: number
  /** Retry attempts after the first failure. */
  readonly maxRetries: number
}

/** Authentication-gated device registration request. */
export interface PushRegistrationRequest {
  /** Caller-chosen stable device identifier. */
  readonly deviceId: string
  /** Target push platform; iOS is the only mounted surface. */
  readonly platform: 'ios'
  /** Opaque APNs device token. Stored on disk only, never logged. */
  readonly token: string
}

/** One stored device registration. */
export interface DeviceRegistration {
  /** Caller-chosen stable device identifier. */
  readonly deviceId: string
  /** Target push platform. */
  readonly platform: string
  /** Opaque APNs device token. */
  readonly token: string
  /** Registration time in host-clock milliseconds. */
  readonly registeredAt: number
}

/** One device registration without its token. */
export interface DeviceView {
  /** Caller-chosen stable device identifier. */
  readonly deviceId: string
  /** Target push platform. */
  readonly platform: string
  /** Registration time in host-clock milliseconds. */
  readonly registeredAt: number
}

/** On-disk registry document behind `devices.json`. */
export interface StoredRegistry {
  /** Every currently registered device. */
  readonly devices: readonly DeviceRegistration[]
}

/** JSON handed to one outbound-command attempt on stdin. */
export interface OutboundPayload {
  /** The notification being delivered. */
  readonly event: NotificationEvent
  /** Target device including the token the command signs with. */
  readonly device: {
    readonly deviceId: string
    readonly platform: string
    readonly token: string
  }
}

/** Recorded delivery result. */
export interface DeliveryRecord {
  /** Session the notification belongs to. */
  readonly sessionId: string
  /** Notification kind that was delivered. */
  readonly kind: NotificationKind
  /** Device the notification was delivered to. */
  readonly deviceId: string
  /** Whether the final attempt exited 0. */
  readonly outcome: 'delivered' | 'failed'
  /** Total attempts spent, including the first. */
  readonly attempts: number
  /** Wall time of all attempts in milliseconds. */
  readonly durationMs: number
  /** Delivery time in host-clock milliseconds. */
  readonly at: number
  /** Short failure reason: exit code or timeout; absent when delivered. */
  readonly error?: string
}
