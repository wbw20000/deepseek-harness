/**
 * Trusted-clock behavior: `kern.boottime` parsing into a stable boot id,
 * sysctl reader failure classification, and non-decreasing monotonic
 * observations with per-observation boot reads.
 * @module clock.spec
 */

import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostClock, parseKernBoottime, readBootTimeSysctl } from '../src/clock.ts'
import { SelfDevelopmentRunnerError } from '../src/runtime.ts'

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}))

afterEach(() => {
  vi.mocked(spawnSync).mockReset()
})

describe('parseKernBoottime', () => {
  it('parses kern.boottime and derives a stable boot id', () => {
    const a = parseKernBoottime('{ sec = 1758150000, usec = 123456 } Thu Sep 18 08:00:00 2026')
    expect(a.bootEpochMs).toBe(1758150000123)
    expect(a.bootId).toMatch(/^[0-9a-f]{64}$/)
    expect(parseKernBoottime('{ sec = 1758150000, usec = 123456 }').bootId).toBe(a.bootId)
  })

  it('derives different boot ids for different boot times', () => {
    const a = parseKernBoottime('{ sec = 1758150000, usec = 123456 }')
    const b = parseKernBoottime('{ sec = 1758150001, usec = 123456 }')
    expect(b.bootId).not.toBe(a.bootId)
  })

  it.each([
    ['no sec field', '{ usec = 123456 }'],
    ['non-numeric sec', '{ sec = soon, usec = 123456 }'],
    ['empty text', ''],
  ])('refuses %s', (_name, text) => {
    expect(() => parseKernBoottime(text)).toThrow(expect.objectContaining({ code: 'SELF_DEV_RUNNER_CLOCK_UNAVAILABLE' }))
  })
})

describe('readBootTimeSysctl', () => {
  it('reads the boot time through a two-second-bounded sysctl call', () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: Buffer.from('{ sec = 1758150000, usec = 123456 } Thu Sep 18 08:00:00 2026\n'),
      stderr: Buffer.from(''),
    } as ReturnType<typeof spawnSync>)
    const bootTime = readBootTimeSysctl()
    expect(bootTime.bootEpochMs).toBe(1758150000123)
    expect(spawnSync).toHaveBeenCalledWith('sysctl', ['-n', 'kern.boottime'], { timeout: 2000 })
  })

  it('classifies a sysctl exit failure as clock unavailable', () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 1,
      stdout: Buffer.from(''),
      stderr: Buffer.from('sysctl: unknown oid'),
    } as ReturnType<typeof spawnSync>)
    expect(() => readBootTimeSysctl()).toThrow(expect.objectContaining({ code: 'SELF_DEV_RUNNER_CLOCK_UNAVAILABLE' }))
  })

  it('classifies unparseable sysctl output as clock unavailable', () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: Buffer.from('not a boottime record'),
      stderr: Buffer.from(''),
    } as ReturnType<typeof spawnSync>)
    expect(() => readBootTimeSysctl()).toThrow(SelfDevelopmentRunnerError)
  })

  it('classifies a sysctl call that times out as clock unavailable', () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: null,
      signal: 'SIGTERM',
      stdout: Buffer.from(''),
      stderr: Buffer.from(''),
    } as unknown as ReturnType<typeof spawnSync>)
    expect(() => readBootTimeSysctl()).toThrow(/timed out or could not start/)
    expect(() => readBootTimeSysctl()).toThrow(expect.objectContaining({ code: 'SELF_DEV_RUNNER_CLOCK_UNAVAILABLE' }))
  })

  it('classifies a sysctl binary that cannot start as clock unavailable', () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: null,
      signal: null,
      error: Object.assign(new Error('spawn sysctl ENOENT'), { code: 'ENOENT' }),
      stdout: Buffer.from(''),
      stderr: Buffer.from(''),
    } as unknown as ReturnType<typeof spawnSync>)
    expect(() => readBootTimeSysctl()).toThrow(/timed out or could not start: .*ENOENT/)
    expect(() => readBootTimeSysctl()).toThrow(expect.objectContaining({ code: 'SELF_DEV_RUNNER_CLOCK_UNAVAILABLE' }))
  })
})

describe('HostClock', () => {
  it('observes non-decreasing monotonic milliseconds and surfaces reader failure', () => {
    const clock = new HostClock(() => ({ bootEpochMs: Date.now() - 5000, bootId: 'b'.repeat(64) }))
    const first = clock.observe()
    const second = clock.observe()
    expect(second.monotonicMs).toBeGreaterThanOrEqual(first.monotonicMs)
    expect(first.monotonicMs).toBeGreaterThanOrEqual(5000)
    expect(() => new HostClock(() => { throw new Error('no sysctl') }).observe())
      .toThrow(expect.objectContaining({ code: 'SELF_DEV_RUNNER_CLOCK_UNAVAILABLE' }))
  })

  it('wraps non-error reader failures into the same clock-unavailable code', () => {
    expect(() => new HostClock(() => {
      throw 'sysctl crashed'
    }).observe()).toThrow(SelfDevelopmentRunnerError)
  })

  it('rethrows an existing SelfDevelopmentRunnerError without wrapping it again', () => {
    const original = new SelfDevelopmentRunnerError(
      'sysctl -n kern.boottime exited with 1: unknown oid',
      'SELF_DEV_RUNNER_CLOCK_UNAVAILABLE',
    )
    let caught: unknown
    try {
      new HostClock(() => {
        throw original
      }).observe()
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toBe(original)
  })

  it('re-reads the boot time on every observation', () => {
    const read = vi.fn(() => ({ bootEpochMs: Date.now() - 1000, bootId: 'c'.repeat(64) }))
    const clock = new HostClock(read)
    clock.observe()
    clock.observe()
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('reports the observation fields verbatim from the reader', () => {
    const clock = new HostClock(() => ({ bootEpochMs: 1_000_000, bootId: 'd'.repeat(64) }))
    vi.spyOn(Date, 'now').mockReturnValue(1_002_500)
    try {
      expect(clock.observe()).toEqual({ bootId: 'd'.repeat(64), monotonicMs: 2500 })
    } finally {
      vi.restoreAllMocks()
    }
  })
})
