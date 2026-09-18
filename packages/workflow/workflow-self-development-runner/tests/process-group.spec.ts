/** Final process-group cleanup and fail-closed exit confirmation. @module process-group.spec */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertProcessGroupSupport, finishProcessGroup } from '../src/process-group.ts'

afterEach(() => { vi.restoreAllMocks() })

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
})
