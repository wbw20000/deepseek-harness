/** Explicit config resolution for the self-development events service. */

import type { ResolvedSelfDevelopmentEventsConfig, SelfDevelopmentEventsConfig } from './types.ts'

/** Default number of events retained in the in-memory recent buffer. */
export const DEFAULT_RECENT_LIMIT = 200

/**
 * Resolve the deployment configuration into the validated shape the service
 * runs under. Defaults are applied here, once, so the service never reads a
 * half-specified config. Notifications stay disabled unless an explicit argv
 * is configured.
 * @param config - raw deployment configuration.
 * @returns the resolved configuration.
 * @throws Error when a field violates its documented domain.
 */
export function resolveSelfDevelopmentEventsConfig(config: SelfDevelopmentEventsConfig): ResolvedSelfDevelopmentEventsConfig {
  const localNotificationCommand = config.localNotificationCommand === undefined
    ? undefined
    : validateCommand(config.localNotificationCommand)
  const recentLimit = config.recentLimit ?? DEFAULT_RECENT_LIMIT
  if (!Number.isSafeInteger(recentLimit) || recentLimit < 1) {
    throw new Error(`self-development-events: recentLimit must be a positive integer, got ${String(config.recentLimit)}`)
  }
  return { localNotificationCommand, recentLimit }
}

/** Validate the notification argv and return it defensively copied. */
function validateCommand(localNotificationCommand: readonly string[]): readonly string[] {
  if (localNotificationCommand.length === 0
    || localNotificationCommand.some(part => typeof part !== 'string' || part.length === 0)) {
    throw new Error('self-development-events: localNotificationCommand must be a non-empty argv array of non-empty strings')
  }
  return [...localNotificationCommand]
}
