/** Wire-request builders and failure rendering. */
import { describe, expect, it } from 'vitest'
import { buildBudgetApproval, buildConfirmedPlan, buildRunAttemptRequest, failureText, parsePaths, parsePorts } from '../src/client/wire.ts'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en } from '../src/client/locales.ts'

const t = makeTranslate(en)

describe('self-development wire builders', () => {
  it('renders known failure codes with fixed wording and unknown ones with the wire text', () => {
    expect(failureText(t, { code: 'SELF_DEV_REMOTE_DISABLED', message: 'ignored' })).toBe('The self-development remote service is disabled (enabled: false)')
    expect(failureText(t, { code: 'SELF_DEV_OTHER', message: 'boom' })).toBe('The operation failed: boom')
  })

  it('parses the loopback port allowlist, dropping malformed and out-of-range entries', () => {
    expect(parsePorts('5173, 9229')).toEqual([5173, 9229])
    expect(parsePorts('65535')).toEqual([65535])
    expect(parsePorts('65536, -1, abc, ,')).toEqual([])
    expect(parsePorts('')).toEqual([])
  })

  it('splits a comma-separated path list into trimmed non-empty entries', () => {
    expect(parsePaths(' a/b.ts , c/d.ts ,, ')).toEqual(['a/b.ts', 'c/d.ts'])
    expect(parsePaths(',')).toEqual([])
  })

  it('builds the run-attempt request from the form, keeping dataHome only when stable-side filled it', () => {
    const request = buildRunAttemptRequest(
      'task-1', 3,
      {
        confirmedBy: ' mima ', worktree: ' /repo/.experiments/task-1 ', artifactPaths: 'a.ts, b.ts',
        acceptancePath: ' /repo/acceptance.yml ', dataHome: ' /repo/.experiments/task-1/dsh-home ', ports: '5173',
      },
      false, true,
    )
    expect(request).toEqual({
      taskId: 'task-1', expectedRevision: 3,
      worktree: '/repo/.experiments/task-1',
      artifactPaths: ['a.ts', 'b.ts'],
      acceptancePath: '/repo/acceptance.yml',
      dataHome: '/repo/.experiments/task-1/dsh-home',
      confirmedBy: 'mima',
      loopbackAllowlist: [5173],
      presenceAcknowledged: true,
    })
  })

  it('omits dataHome on the phone whitelist view and when the form left it empty, and carries the acknowledgement verbatim', () => {
    const form = { confirmedBy: 'mima', worktree: '/w', artifactPaths: 'a.ts', acceptancePath: '/a.yml', dataHome: '/home', ports: '' }
    expect(buildRunAttemptRequest('task-1', 0, form, true, true).dataHome).toBeUndefined()
    expect(buildRunAttemptRequest('task-1', 0, { ...form, dataHome: ' ' }, false, true).dataHome).toBeUndefined()
    expect(buildRunAttemptRequest('task-1', 0, form, false, true).presenceAcknowledged).toBe(true)
    expect(buildRunAttemptRequest('task-1', 0, form, false, false).presenceAcknowledged).toBe(false)
  })

  it('builds the budget approval, binding the frozen versions and omitting unset or invalid limits', () => {
    const approval = buildBudgetApproval(
      { mode: 'both', maxRounds: '4', durationMs: '600000', phaseTimeoutMs: '0', maxStepsPerAttempt: 'x', noProgressAttemptLimit: '' },
      2, 1, ' mima ',
    )
    expect(approval).toEqual({ mode: 'both', maxRounds: 4, durationMs: 600000, testPlanVersion: 2, taskSpecVersion: 1, approvedBy: 'mima' })
    expect(buildBudgetApproval(
      { mode: 'both', maxRounds: '4', durationMs: '600000', phaseTimeoutMs: '120000', maxStepsPerAttempt: '40', noProgressAttemptLimit: '2' },
      2, 1, 'mima',
    )).toEqual({
      mode: 'both', maxRounds: 4, durationMs: 600000, phaseTimeoutMs: 120000, maxStepsPerAttempt: 40, noProgressAttemptLimit: 2,
      testPlanVersion: 2, taskSpecVersion: 1, approvedBy: 'mima',
    })
    expect(buildBudgetApproval(
      { mode: 'rounds', maxRounds: '', durationMs: '', phaseTimeoutMs: '', maxStepsPerAttempt: '', noProgressAttemptLimit: '' },
      2, 1, 'mima',
    )).toEqual({ mode: 'rounds', testPlanVersion: 2, taskSpecVersion: 1, approvedBy: 'mima' })
  })

  it('builds the confirmed plan from the plan view without carrying a digest', () => {
    expect(buildConfirmedPlan({
      testPlanId: 'plan-1', version: 2, taskSpecVersion: 1,
      requiredCases: [{ caseId: 'case-1', requirement: 'r', assertionIds: ['a'] }],
      manualCases: ['m'],
    })).toEqual({
      testPlanId: 'plan-1', version: 2, taskSpecVersion: 1,
      requiredCases: [{ caseId: 'case-1', requirement: 'r', assertionIds: ['a'] }],
      manualCases: ['m'],
    })
  })
})
