/** Wire-request builders and failure rendering. */
import { describe, expect, it } from 'vitest'
import {
  buildBudgetApproval, buildConfirmedPlan, buildCreateTaskSpec, buildLaunchProfileInput, buildPlanDraft,
  buildRunAttemptRequest, failureText, launchProfileOf, parsePaths, parsePorts, trialApprovalOf,
} from '../src/client/wire.ts'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en } from '../src/client/locales.ts'
import { card, projection } from './fixtures.client.ts'

const t = makeTranslate(en)

describe('self-development wire builders', () => {
  it('renders known failure codes with fixed wording and unknown ones with the wire text', () => {
    expect(failureText(t, { code: 'self-development/disabled', message: 'ignored' })).toBe('The self-development remote service is disabled (enabled: false)')
    expect(failureText(t, { code: 'self-development/host-only-field', message: 'ignored' })).toBe('This operation can only be completed at the computer; a phone can view, confirm, and stop only')
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

  it('builds the three-key launch request when the advanced form is untouched and no actor is named', () => {
    expect(buildRunAttemptRequest('task-1', 3, {
      worktree: '', artifactPaths: '', acceptancePath: '', dataHome: '', ports: '',
    }, false, true)).toEqual({ taskId: 'task-1', expectedRevision: 3, presenceAcknowledged: true })
  })

  it('builds the run-attempt request from the overrides, keeping dataHome only when stable-side filled it', () => {
    const request = buildRunAttemptRequest(
      'task-1', 3,
      {
        worktree: ' /repo/.experiments/task-1 ', artifactPaths: 'a.ts, b.ts',
        acceptancePath: ' /repo/acceptance.yml ', dataHome: ' /repo/.experiments/task-1/dsh-home ', ports: '5173',
      },
      false, true, ' mima ',
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
    const form = { worktree: '/w', artifactPaths: 'a.ts', acceptancePath: '/a.yml', dataHome: '/home', ports: '' }
    expect(buildRunAttemptRequest('task-1', 0, form, true, true).dataHome).toBeUndefined()
    expect(buildRunAttemptRequest('task-1', 0, { ...form, dataHome: ' ' }, false, true).dataHome).toBeUndefined()
    expect(buildRunAttemptRequest('task-1', 0, form, false, true).presenceAcknowledged).toBe(true)
    expect(buildRunAttemptRequest('task-1', 0, form, false, false).presenceAcknowledged).toBe(false)
    expect(buildRunAttemptRequest('task-1', 0, form, false, true).confirmedBy).toBeUndefined()
  })

  it('builds the create-task spec with version one and a parsed scope', () => {
    expect(buildCreateTaskSpec({
      taskId: ' task-2 ', requirement: ' 补充导出 ', scope: ' a/** , b/** ',
      baseline: 'a'.repeat(64), createdBy: ' mima ',
    })).toEqual({
      taskId: 'task-2', version: 1, requirement: '补充导出',
      allowedModificationScope: ['a/**', 'b/**'], stableBaselineDigest: 'a'.repeat(64), createdBy: 'mima',
    })
  })

  it('builds the launch-profile input only when a required path is filled', () => {
    expect(buildLaunchProfileInput({ worktree: '', acceptancePath: '', artifactPaths: 'a.ts' })).toBeUndefined()
    expect(buildLaunchProfileInput({ worktree: ' /wt ', acceptancePath: ' /a.yml ', artifactPaths: ' a.ts , ' })).toEqual({
      worktree: '/wt', acceptancePath: '/a.yml', artifactPaths: ['a.ts'],
    })
    expect(buildLaunchProfileInput({ worktree: '/wt', acceptancePath: '/a.yml', artifactPaths: '' })).toEqual({
      worktree: '/wt', acceptancePath: '/a.yml',
    })
  })

  it('builds the plan draft, dropping half-typed rows and splitting manual cases', () => {
    expect(buildPlanDraft([
      { caseId: ' case-1 ', requirement: ' 导出生成文件 ', assertionIds: ' assert-1 , assert-2 ' },
      { caseId: '', requirement: 'dropped', assertionIds: 'x' },
      { caseId: 'case-3', requirement: '', assertionIds: 'y' },
    ], ' 人工核对 , 人工打印 ')).toEqual({
      requiredCases: [{ caseId: 'case-1', requirement: '导出生成文件', assertionIds: ['assert-1', 'assert-2'] }],
      manualCases: ['人工核对', '人工打印'],
    })
  })

  it('reads the launch profile and the trial approval off the card and projection views', () => {
    expect(launchProfileOf(card({ launchProfile: {
      worktree: '/wt', acceptancePath: '/a', artifactPaths: [], loopbackAllowlist: [], confirmedBy: 'm', updatedAt: 1,
    } }))?.worktree).toBe('/wt')
    expect(launchProfileOf(card())).toBeUndefined()
    expect(trialApprovalOf(projection({ trialApproval: { approvedBy: 'mima', resultDigest: 'f'.repeat(64) } }), card())?.approvedBy).toBe('mima')
    expect(trialApprovalOf(projection(), card({ trialApproval: { approvedBy: 'k3', resultDigest: 'f' } }))?.approvedBy).toBe('k3')
    expect(trialApprovalOf(projection(), card())).toBeUndefined()
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
