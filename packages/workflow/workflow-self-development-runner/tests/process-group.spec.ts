/** Final process-group cleanup and fail-closed exit confirmation. @module process-group.spec */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertProcessGroupSupport, finishProcessGroup, readGroupLeaderStartedAt } from '../src/process-group.ts'

/** Controlled `ps` answers for the leader start-time fingerprint. */
const ps = vi.hoisted(() => ({
  error: undefined as Error | null | undefined,
  stdout: '',
  throwSync: false,
}))

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>()
  return {
    ...actual,
    // `ps` never runs here: the fingerprint tests pin its two answers.
    execFile: (_file: string, _args: string[], callback: (error: Error | null, stdout: string) => void) => {
      if (ps.throwSync) throw new Error('spawn EPERM')
      queueMicrotask(() => {
        callback(ps.error ?? null, ps.stdout)
      })
    },
  }
})

afterEach(() => {
  ps.error = undefined
  ps.stdout = ''
  ps.throwSync = false
  vi.restoreAllMocks()
})

/** A kill double: group signals answer with the given errno, pid probes stay real. */
function mockGroupKill(code: string | undefined) {
  const killOriginal = process.kill.bind(process)
  return vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
    if (pid < 0) {
      if (code === undefined) return true
      throw Object.assign(new Error('denied'), { code })
    }
    return killOriginal(pid, signal)
  })
}

describe('finishProcessGroup', () => {
  it('refuses Windows process-group execution before launch', () => {
    expect(() => { assertProcessGroupSupport('win32') }).toThrow('Windows execution is unavailable')
    expect(() => { assertProcessGroupSupport('darwin') }).not.toThrow()
    expect(() => { assertProcessGroupSupport('linux') }).not.toThrow()
  })
  it('does not signal after a failed spawn or an already-exited group', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) })
    await finishProcessGroup(undefined, 100)
    expect(kill).not.toHaveBeenCalled()
    await finishProcessGroup(123, 100)
    expect(kill.mock.calls).toEqual([[-123, 0]])
  })

  it('waits for remaining descendants after one final SIGKILL', async () => {
    let probes = 0
    const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 0 && ++probes >= 3) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
      return true
    })
    await finishProcessGroup(123, 1000)
    expect(kill.mock.calls).toEqual([[-123, 0], [-123, 'SIGKILL'], [-123, 0], [-123, 0]])
  })

  it.each([Object.assign(new Error('denied'), { code: 'EPERM' }), null, 'failed'])('rejects an unconfirmed signal failure: %s', async (error) => {
    vi.spyOn(process, 'kill').mockImplementation(() => { throw error })
    await expect(finishProcessGroup(123, 100)).rejects.toMatchObject({ code: 'SELF_DEV_RUNNER_EXECUTOR_FAILED' })
  })

  it('rejects when the group remains visible past the final wait', async () => {
    vi.spyOn(process, 'kill').mockReturnValue(true)
    await expect(finishProcessGroup(123, 0)).rejects.toThrow('exit was not confirmed')
  })

  it('treats EPERM as a reused pgid when the spawned leader is gone', async () => {
    // The leader pid is dead, so the real probe answers ESRCH.
    const kill = mockGroupKill('EPERM')
    const leader = { pid: Number.MAX_SAFE_INTEGER, exited: true, startedAt: undefined }
    await expect(finishProcessGroup(123, 100, leader)).resolves.toEqual({ pgidReused: true })
    // The reassigned group is never signalled.
    expect(kill.mock.calls.filter(call => call[0] < 0)).toEqual([[-123, 0]])
  })

  it('treats EPERM as a reused pgid when a surviving pid cannot be ours', async () => {
    // A live probe on an exited, fingerprint-less leader names a reused pid.
    const kill = mockGroupKill('EPERM')
    const leader = { pid: process.pid, exited: true, startedAt: undefined }
    await expect(finishProcessGroup(123, 100, leader)).resolves.toEqual({ pgidReused: true })
    expect(kill.mock.calls.filter(call => call[0] < 0)).toEqual([[-123, 0]])
  })

  it('treats EPERM as a reused pgid when the start time no longer matches', async () => {
    mockGroupKill('EPERM')
    ps.stdout = 'Wed Jan  7 00:00:00 2026'
    const leader = { pid: process.pid, exited: true, startedAt: 'Tue Jan  6 00:00:00 2026' }
    await expect(finishProcessGroup(123, 100, leader)).resolves.toEqual({ pgidReused: true })
  })

  it('treats EPERM as a reused pgid when the start time cannot be re-read', async () => {
    mockGroupKill('EPERM')
    ps.error = Object.assign(new Error('no such process'), { code: 1 })
    const leader = { pid: process.pid, exited: true, startedAt: 'Tue Jan  6 00:00:00 2026' }
    await expect(finishProcessGroup(123, 100, leader)).resolves.toEqual({ pgidReused: true })
  })

  it('resolves no fingerprint when the host denies `ps` synchronously', async () => {
    // Some hosts reject the spawn before the callback is ever scheduled.
    ps.throwSync = true
    await expect(readGroupLeaderStartedAt(process.pid)).resolves.toBeUndefined()
  })

  it('treats EPERM as a reused pgid when the synchronous `ps` denial leaves the fingerprint unknown', async () => {
    // Without a readable fingerprint the leader cannot be confirmed ours, so
    // the reassigned group is never signalled and the run still succeeds.
    const kill = mockGroupKill('EPERM')
    ps.throwSync = true
    const leader = { pid: process.pid, exited: true, startedAt: 'Tue Jan  6 00:00:00 2026' }
    await expect(finishProcessGroup(123, 100, leader)).resolves.toEqual({ pgidReused: true })
    expect(kill.mock.calls.filter(call => call[0] < 0)).toEqual([[-123, 0]])
  })

  it('still fails closed on EPERM when the fingerprinted leader is still ours', async () => {
    mockGroupKill('EPERM')
    ps.stdout = 'Tue Jan  6 00:00:00 2026'
    const leader = { pid: process.pid, exited: true, startedAt: 'Tue Jan  6 00:00:00 2026' }
    await expect(finishProcessGroup(123, 100, leader)).rejects.toMatchObject({ code: 'SELF_DEV_RUNNER_EXECUTOR_FAILED' })
  })

  it('still fails closed on EPERM when the leader was never observed exiting', async () => {
    mockGroupKill('EPERM')
    const leader = { pid: process.pid, exited: false, startedAt: undefined }
    await expect(finishProcessGroup(123, 100, leader)).rejects.toMatchObject({ code: 'SELF_DEV_RUNNER_EXECUTOR_FAILED' })
  })

  it('still fails closed on EPERM without any leader record', async () => {
    mockGroupKill('EPERM')
    await expect(finishProcessGroup(123, 100, undefined)).rejects.toMatchObject({ code: 'SELF_DEV_RUNNER_EXECUTOR_FAILED' })
  })
})
