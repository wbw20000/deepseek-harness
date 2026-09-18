/**
 * Human-presence capability evidence: one evidence item per required
 * capability, each bound by digest to the capability name and the concrete
 * confirmation, plus constructor validation of the confirmation record.
 * @module presence.spec
 */

import { describe, expect, it } from 'vitest'
import { digestJson } from '@deepseek-ai/dsh-workflow-self-development'
import { HumanPresenceCapabilitySource } from '../src/presence.ts'
import type { PresenceConfirmation } from '../src/presence.ts'
import { SelfDevelopmentRunnerError } from '../src/runtime.ts'

const BOOT_ID = 'a'.repeat(64)

const PLAN_DIGEST = 'b'.repeat(64)
const ACCEPTANCE_DIGEST = 'c'.repeat(64)

const confirmation: PresenceConfirmation = {
  confirmedBy: 'operator-1',
  confirmedAt: { bootId: BOOT_ID, monotonicMs: 1234 },
  worktree: '/experiments/wt-1',
  loopbackAllowlist: [4173, 8080],
  acknowledgement: 'supervised-not-unattended',
  taskId: 'task-1',
  testPlanDigest: PLAN_DIGEST,
  acceptanceDefinitionDigest: ACCEPTANCE_DIGEST,
  artifactPaths: ['dist/cli.js', 'lib'],
}

describe('HumanPresenceCapabilitySource', () => {
  it('produces one human-presence evidence item per required capability', () => {
    const required = ['supervisor', 'external-verifier', 'experiment-isolation', 'acceptance-runner']
    const evidence = new HumanPresenceCapabilitySource(confirmation).evidence(required)
    expect(evidence.map(item => item.capability)).toEqual(required)
    for (const item of evidence) {
      expect(item.source).toBe('human-presence')
      expect(item.digest).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('binds each digest to the capability name and the confirmation payload', () => {
    const evidence = new HumanPresenceCapabilitySource(confirmation).evidence(['supervisor', 'external-verifier'])
    for (const item of evidence) {
      expect(item.digest).toBe(digestJson({ capability: item.capability, source: 'human-presence', confirmation }))
    }
  })

  it('returns identical digests for repeated calls with the same confirmation', () => {
    const source = new HumanPresenceCapabilitySource(confirmation)
    const first = source.evidence(['supervisor'])
    const second = source.evidence(['supervisor'])
    expect(second).toEqual(first)
  })

  it('keeps the captured evidence when the caller mutates its original confirmation', () => {
    const input = { ...confirmation, confirmedAt: { ...confirmation.confirmedAt }, loopbackAllowlist: [4173] }
    const source = new HumanPresenceCapabilitySource(input)
    const before = source.evidence(['supervisor'])
    input.confirmedAt.monotonicMs += 1
    input.loopbackAllowlist.push(8080)
    expect(source.evidence(['supervisor'])).toEqual(before)
  })

  it('keeps the artifact path set as a unique ascending list, so order and repeats never change the digest', () => {
    const unordered = { ...confirmation, artifactPaths: ['lib', 'dist/cli.js', 'lib'] }
    const evidence = new HumanPresenceCapabilitySource(unordered).evidence(['supervisor'])
    expect(evidence[0]?.digest).toBe(digestJson({ capability: 'supervisor', source: 'human-presence', confirmation }))
  })

  it('changes the digest when the bound launch facts change', () => {
    const base = new HumanPresenceCapabilitySource(confirmation).evidence(['supervisor'])[0]?.digest
    const variants: PresenceConfirmation[] = [
      { ...confirmation, taskId: 'task-2' },
      { ...confirmation, testPlanDigest: 'd'.repeat(64) },
      { ...confirmation, acceptanceDefinitionDigest: 'e'.repeat(64) },
      { ...confirmation, artifactPaths: ['lib'] },
    ]
    for (const variant of variants) {
      expect(new HumanPresenceCapabilitySource(variant).evidence(['supervisor'])[0]?.digest).not.toBe(base)
    }
  })

  it('produces different digests for different confirmations and capabilities', () => {
    const later: PresenceConfirmation = {
      ...confirmation,
      confirmedAt: { bootId: BOOT_ID, monotonicMs: 2345 },
    }
    const base = new HumanPresenceCapabilitySource(confirmation).evidence(['supervisor', 'external-verifier'])
    const reconfirmed = new HumanPresenceCapabilitySource(later).evidence(['supervisor', 'external-verifier'])
    expect(reconfirmed[0]?.digest).not.toBe(base[0]?.digest)
    expect(reconfirmed[1]?.digest).not.toBe(base[1]?.digest)
    expect(base[0]?.digest).not.toBe(base[1]?.digest)
  })

  /**
   * Malformed confirmations the constructor must refuse at the config
   * boundary. Each payload is `unknown` because these records arrive from
   * outside the module's static type; the cast at the call claims the
   * confirmation type, and validation is what must see through it.
   */
  const invalidConfirmations: ReadonlyArray<[name: string, malformed: unknown]> = [
    ['null confirmation', null],
    ['non-object confirmation', 'confirmed'],
    ['empty confirmedBy', { ...confirmation, confirmedBy: '' }],
    ['non-string confirmedBy', { ...confirmation, confirmedBy: 42 }],
    ['missing confirmedAt', { ...confirmation, confirmedAt: undefined }],
    ['non-object confirmedAt', { ...confirmation, confirmedAt: 'not-a-clock' }],
    ['non-hex bootId', { ...confirmation, confirmedAt: { bootId: 'zz'.repeat(32), monotonicMs: 1 } }],
    ['non-string bootId', { ...confirmation, confirmedAt: { bootId: 1, monotonicMs: 1 } }],
    ['non-number monotonicMs', { ...confirmation, confirmedAt: { bootId: BOOT_ID, monotonicMs: '1' } }],
    ['negative monotonicMs', { ...confirmation, confirmedAt: { bootId: BOOT_ID, monotonicMs: -1 } }],
    ['non-integer monotonicMs', { ...confirmation, confirmedAt: { bootId: BOOT_ID, monotonicMs: 1.5 } }],
    ['missing worktree', { ...confirmation, worktree: undefined }],
    ['non-string worktree', { ...confirmation, worktree: 42 }],
    ['relative worktree', { ...confirmation, worktree: 'experiments/wt-1' }],
    ['missing loopbackAllowlist', { ...confirmation, loopbackAllowlist: undefined }],
    ['non-array loopbackAllowlist', { ...confirmation, loopbackAllowlist: '4173' }],
    ['out-of-range loopback port', { ...confirmation, loopbackAllowlist: [4173, 70000] }],
    ['missing acknowledgement', { ...confirmation, acknowledgement: undefined }],
    ['non-string acknowledgement', { ...confirmation, acknowledgement: 42 }],
    ['wrong acknowledgement', { ...confirmation, acknowledgement: 'unattended' }],
    ['missing taskId', { ...confirmation, taskId: undefined }],
    ['non-string taskId', { ...confirmation, taskId: 42 }],
    ['path-like taskId', { ...confirmation, taskId: '../escape' }],
    ['non-string testPlanDigest', { ...confirmation, testPlanDigest: 42 }],
    ['non-hex testPlanDigest', { ...confirmation, testPlanDigest: 'Z'.repeat(64) }],
    ['missing acceptanceDefinitionDigest', { ...confirmation, acceptanceDefinitionDigest: undefined }],
    ['short acceptanceDefinitionDigest', { ...confirmation, acceptanceDefinitionDigest: 'ab' }],
    ['missing artifactPaths', { ...confirmation, artifactPaths: undefined }],
    ['non-array artifactPaths', { ...confirmation, artifactPaths: 'lib' }],
    ['non-string artifact path', { ...confirmation, artifactPaths: [42] }],
    ['empty artifact path', { ...confirmation, artifactPaths: [''] }],
    ['absolute artifact path', { ...confirmation, artifactPaths: ['/etc/passwd'] }],
    ['dot-dot artifact path', { ...confirmation, artifactPaths: ['lib/../../secret'] }],
    ['dot artifact path', { ...confirmation, artifactPaths: ['./lib'] }],
    ['empty-segment artifact path', { ...confirmation, artifactPaths: ['lib//x'] }],
  ]
  it.each(invalidConfirmations)('refuses %s with SELF_DEV_RUNNER_CONFIG_INVALID', (_name, malformed) => {
    const bad = malformed as PresenceConfirmation
    // The runner error, not a bare TypeError: a missing or mistyped field is
    // a config rejection with a machine-routable code, never a crash.
    expect(() => new HumanPresenceCapabilitySource(bad)).toThrow(SelfDevelopmentRunnerError)
    expect(() => new HumanPresenceCapabilitySource(bad))
      .toThrow(expect.objectContaining({ code: 'SELF_DEV_RUNNER_CONFIG_INVALID' }))
  })
})
