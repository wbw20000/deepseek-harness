/** Explicit config resolution for the push-registry service. */

import type { PushRegistryConfig, ResolvedPushRegistryConfig } from './types.ts'

/** Default per-attempt outbound deadline. */
export const DEFAULT_OUTBOUND_TIMEOUT_MS = 15_000

/** Default dedupe window: one notification per session and kind. */
export const DEFAULT_DEDUPE_WINDOW_MS = 60_000

/** Default retry attempts after the first failure. */
export const DEFAULT_MAX_RETRIES = 2

/**
 * Resolve the deployment configuration into the validated shape every
 * delivery runs under. Defaults are applied here, once, so the service never
 * reads a half-specified config.
 * @param config - raw deployment configuration.
 * @returns the resolved configuration.
 * @throws Error when a field violates its documented domain.
 */
export function resolvePushRegistryConfig(config: PushRegistryConfig): ResolvedPushRegistryConfig {
  const { registryDirectory } = config
  if (typeof registryDirectory !== 'string' || !registryDirectory.startsWith('/')) {
    throw new Error('push-registry: registryDirectory must be an absolute path')
  }
  const outboundCommand = config.outboundCommand === undefined
    ? undefined
    : validateOutboundCommand(config.outboundCommand)
  return {
    registryDirectory,
    outboundCommand,
    outboundTimeoutMs: positiveInteger(config.outboundTimeoutMs, DEFAULT_OUTBOUND_TIMEOUT_MS, 'outboundTimeoutMs'),
    dedupeWindowMs: positiveInteger(config.dedupeWindowMs, DEFAULT_DEDUPE_WINDOW_MS, 'dedupeWindowMs'),
    maxRetries: nonNegativeInteger(config.maxRetries, DEFAULT_MAX_RETRIES, 'maxRetries'),
  }
}

/** Validate the outbound argv and return it defensively copied. */
function validateOutboundCommand(outboundCommand: readonly string[]): readonly string[] {
  if (outboundCommand.length === 0 || outboundCommand.some(part => typeof part !== 'string' || part.length === 0)) {
    throw new Error('push-registry: outboundCommand must be a non-empty argv array of non-empty strings')
  }
  return [...outboundCommand]
}

/** Apply one default or require a positive integer. */
function positiveInteger(value: number | undefined, fallback: number, field: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`push-registry: ${field} must be a positive integer, got ${String(value)}`)
  }
  return resolved
}

/** Apply one default or require a non-negative integer. */
function nonNegativeInteger(value: number | undefined, fallback: number, field: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new Error(`push-registry: ${field} must be a non-negative integer, got ${String(value)}`)
  }
  return resolved
}
