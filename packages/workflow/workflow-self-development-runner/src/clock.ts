/**
 * Trusted host clock for the supervised runner: derive a boot-session
 * identity and a sleep-inclusive monotonic millisecond count from the macOS
 * `sysctl kern.boottime` record. This is the Node-side stand-in for the
 * Swift supervisor's trusted clock; it proves the same two properties per
 * observation and nothing more.
 * @module @deepseek-ai/dsh-workflow-self-development-runner/clock
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import type { ClockObservation, TrustedClock } from '@deepseek-ai/dsh-workflow-self-development'
import { SelfDevelopmentRunnerError } from './runtime.ts'

/** One parsed boot-session record: wall-clock boot instant plus its stable identity. */
export interface BootTime {
  /** Unix epoch milliseconds of the most recent OS boot. */
  readonly bootEpochMs: number
  /** sha-256 over the raw `sec`/`usec` pair; stable across reads within one boot session. */
  readonly bootId: string
}

/** Reader of the host boot record; injectable so tests replace `sysctl`. */
export type BootTimeReader = () => BootTime

/** Matches the `{ sec = <int>, usec = <int> }` prefix of `sysctl -n kern.boottime`. */
const BOOTTIME_PATTERN = /\{\s*sec\s*=\s*(\d+)\s*,\s*usec\s*=\s*(\d+)\s*\}/

/**
 * Parse one `sysctl -n kern.boottime` record.
 * @param text - raw sysctl stdout, e.g. `{ sec = 1758150000, usec = 123456 } Thu Sep 18 08:00:00 2026`.
 * @returns the boot epoch in milliseconds and the derived boot id.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_CLOCK_UNAVAILABLE` when the text carries
 *   no integer `sec`/`usec` pair.
 */
export function parseKernBoottime(text: string): BootTime {
  const match = BOOTTIME_PATTERN.exec(text)
  if (match === null) {
    throw new SelfDevelopmentRunnerError(
      `cannot parse kern.boottime record ${JSON.stringify(text.slice(0, 120))}`,
      'SELF_DEV_RUNNER_CLOCK_UNAVAILABLE',
    )
  }
  const sec = match[1]
  const usec = match[2]
  return {
    bootEpochMs: Number(sec) * 1000 + Math.floor(Number(usec) / 1000),
    bootId: createHash('sha256').update(`${sec}.${usec}`).digest('hex'),
  }
}

/**
 * Read the boot record by shelling out to `sysctl`.
 * @returns the parsed boot time.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_CLOCK_UNAVAILABLE` when sysctl cannot
 *   start, times out, exits non-zero, or its output is unparseable.
 */
export function readBootTimeSysctl(): BootTime {
  const result = spawnSync('sysctl', ['-n', 'kern.boottime'], { timeout: 2000 })
  if (result.error !== undefined || result.status === null) {
    throw new SelfDevelopmentRunnerError(
      `sysctl -n kern.boottime timed out or could not start${result.error === undefined ? '' : `: ${result.error.message}`}`,
      'SELF_DEV_RUNNER_CLOCK_UNAVAILABLE',
    )
  }
  if (result.status !== 0) {
    throw new SelfDevelopmentRunnerError(
      `sysctl -n kern.boottime exited with ${String(result.status)}: ${result.stderr.toString('utf8').trim()}`,
      'SELF_DEV_RUNNER_CLOCK_UNAVAILABLE',
    )
  }
  return parseKernBoottime(result.stdout.toString('utf8'))
}

/**
 * Trusted clock over the host boot record. Every observation re-reads the
 * boot time so a reboot between observations surfaces as a new `bootId`
 * instead of a silently stretched monotonic count.
 */
export class HostClock implements TrustedClock {
  /** Injected boot-record reader. */
  private readonly read: BootTimeReader

  /**
   * @param read - boot-record reader; defaults to the real sysctl call.
   */
  constructor(read: BootTimeReader = readBootTimeSysctl) {
    this.read = read
  }

  /**
   * Read one trusted observation from the current boot session.
   * @returns the boot id and wall-clock-derived monotonic milliseconds.
   * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_CLOCK_UNAVAILABLE` when the reader
   *   throws, so callers can refuse to launch an attempt instead of guessing time. An error that
   *   already carries a runner code is rethrown as-is instead of being wrapped again.
   */
  observe(): ClockObservation {
    let bootTime: BootTime
    try {
      bootTime = this.read()
    } catch (error: unknown) {
      if (error instanceof SelfDevelopmentRunnerError) throw error
      throw new SelfDevelopmentRunnerError(
        `trusted clock is unavailable: ${error instanceof Error ? error.message : String(error)}`,
        'SELF_DEV_RUNNER_CLOCK_UNAVAILABLE',
      )
    }
    return { bootId: bootTime.bootId, monotonicMs: Math.floor(Date.now() - bootTime.bootEpochMs) }
  }
}
