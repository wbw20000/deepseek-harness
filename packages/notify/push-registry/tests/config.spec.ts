/**
 * Config-resolution behavior: defaults, defensive argv copying, and the loud
 * rejection of every out-of-domain field.
 * @module config.spec
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DEDUPE_WINDOW_MS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_OUTBOUND_TIMEOUT_MS,
  resolvePushRegistryConfig,
} from '../src/config.ts'

describe('resolvePushRegistryConfig', () => {
  it('applies the documented defaults to absent fields', () => {
    expect(resolvePushRegistryConfig({ registryDirectory: '/tmp/registry' })).toEqual({
      registryDirectory: '/tmp/registry',
      outboundCommand: undefined,
      outboundTimeoutMs: DEFAULT_OUTBOUND_TIMEOUT_MS,
      dedupeWindowMs: DEFAULT_DEDUPE_WINDOW_MS,
      maxRetries: DEFAULT_MAX_RETRIES,
    })
  })

  it('copies the outbound argv instead of retaining the caller array', () => {
    const command = ['/usr/bin/apns-send']
    const resolved = resolvePushRegistryConfig({ registryDirectory: '/tmp/registry', outboundCommand: command })
    command.push('/extra')
    expect(resolved.outboundCommand).toEqual(['/usr/bin/apns-send'])
  })

  it('rejects a relative registry directory', () => {
    expect(() => resolvePushRegistryConfig({ registryDirectory: 'relative/registry' }))
      .toThrow('registryDirectory must be an absolute path')
    expect(() => resolvePushRegistryConfig({ registryDirectory: 3 as never }))
      .toThrow('registryDirectory must be an absolute path')
  })

  it('rejects an empty or non-string outbound argv', () => {
    expect(() => resolvePushRegistryConfig({ registryDirectory: '/tmp/r', outboundCommand: [] }))
      .toThrow('outboundCommand must be a non-empty argv array')
    expect(() => resolvePushRegistryConfig({ registryDirectory: '/tmp/r', outboundCommand: ['/bin/x', ''] }))
      .toThrow('outboundCommand must be a non-empty argv array')
    expect(() => resolvePushRegistryConfig({ registryDirectory: '/tmp/r', outboundCommand: ['/bin/x', 4 as never] }))
      .toThrow('outboundCommand must be a non-empty argv array')
  })

  it('rejects non-positive timeouts and windows', () => {
    expect(() => resolvePushRegistryConfig({ registryDirectory: '/tmp/r', outboundTimeoutMs: 0 }))
      .toThrow('outboundTimeoutMs must be a positive integer, got 0')
    expect(() => resolvePushRegistryConfig({ registryDirectory: '/tmp/r', dedupeWindowMs: -1 }))
      .toThrow('dedupeWindowMs must be a positive integer, got -1')
    expect(() => resolvePushRegistryConfig({ registryDirectory: '/tmp/r', outboundTimeoutMs: 1.5 }))
      .toThrow('outboundTimeoutMs must be a positive integer, got 1.5')
  })

  it('rejects a negative retry budget', () => {
    expect(() => resolvePushRegistryConfig({ registryDirectory: '/tmp/r', maxRetries: -1 }))
      .toThrow('maxRetries must be a non-negative integer, got -1')
  })
})
