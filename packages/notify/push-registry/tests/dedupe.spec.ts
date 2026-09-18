/**
 * Dedupe-gate behavior: the per-session, per-kind window, window expiry, and
 * the failure dominance that suppresses a failed turn's paired finish.
 * @module dedupe.spec
 */

import { describe, expect, it } from 'vitest'
import { NotificationGate } from '../src/dedupe.ts'
import type { NotificationEvent } from '../src/types.ts'

/** Build one event with mutable occurrence fields for clock-driven tests. */
function event(kind: NotificationEvent['kind'], sessionId: string): NotificationEvent {
  return { kind, sessionId, title: 'fixed', occurredAt: 0 }
}

/** One gate over a controllable clock. */
function gateWith(windowMs: number): { gate: NotificationGate; setTime: (ms: number) => void } {
  let now = 0
  return { gate: new NotificationGate(windowMs, () => now), setTime: (ms) => { now = ms } }
}

describe('NotificationGate', () => {
  it('admits the first event of a key and suppresses repeats inside the window', () => {
    const { gate, setTime } = gateWith(60_000)
    const first = event('turn-finished', 'session-1')

    expect(gate.admit(first)).toBe(true)
    gate.record(first)

    setTime(59_999)
    expect(gate.admit(event('turn-finished', 'session-1'))).toBe(false)
    expect(gate.admit(event('turn-finished', 'session-2'))).toBe(true)
    expect(gate.admit(event('turn-failed', 'session-1'))).toBe(true)
  })

  it('admits again once the window has elapsed', () => {
    const { gate, setTime } = gateWith(60_000)
    const first = event('awaiting-confirmation', 'session-1')
    gate.record(first)

    setTime(60_000)
    expect(gate.admit(event('awaiting-confirmation', 'session-1'))).toBe(true)
  })

  it('suppresses the paired turn-finished while a failure is inside the window', () => {
    const { gate, setTime } = gateWith(60_000)
    const failure = event('turn-failed', 'session-1')
    gate.record(failure)
    gate.markTurnFailed('session-1')

    expect(gate.admit(event('turn-finished', 'session-1'))).toBe(false)
    expect(gate.admit(event('awaiting-confirmation', 'session-1'))).toBe(true)
    setTime(60_000)
    expect(gate.admit(event('turn-finished', 'session-1'))).toBe(true)
  })

  it('records failures under their own dedupe key', () => {
    const { gate, setTime } = gateWith(60_000)
    const failure = event('turn-failed', 'session-1')
    expect(gate.admit(failure)).toBe(true)
    gate.record(failure)

    setTime(59_999)
    expect(gate.admit(event('turn-failed', 'session-1'))).toBe(false)
  })

  it('drops expired entries lazily on the next gate operation', () => {
    const { gate, setTime } = gateWith(60_000)
    for (const session of ['session-1', 'session-2', 'session-3']) {
      gate.record(event('turn-finished', session))
    }
    gate.markTurnFailed('session-2')
    expect(gate.size).toBe(4)

    // Inside the window nothing expires, including on an operation for a new key.
    setTime(59_999)
    gate.admit(event('awaiting-confirmation', 'session-4'))
    expect(gate.size).toBe(4)

    setTime(60_000)
    gate.admit(event('turn-finished', 'session-4'))
    expect(gate.size).toBe(0)

    gate.record(event('turn-finished', 'session-4'))
    gate.markTurnFailed('session-4')
    expect(gate.size).toBe(2)
  })
})
