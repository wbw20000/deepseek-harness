/** Dictionary-key helpers and the action-visibility matrix. */
import { describe, expect, it } from 'vitest'
import type { SelfDevelopmentEventKind } from '@deepseek-ai/dsh-workflow-self-development-events'
import {
  actionLabelKey, actionsFor, dialogDetailKey, dialogTitleKey, errorKey, eventKindKey,
  handoffReasonKey, statusKey, stopReasonKey, type ActionId,
} from '../src/client/status.ts'
import { zh } from '../src/client/locales.ts'

describe('self-development view keys', () => {
  it('maps every task status to its badge copy', () => {
    const statuses = ['draft', 'planning-authorized', 'awaiting-plan-confirmation', 'awaiting-development-approval', 'ready', 'attempting', 'awaiting-trial', 'stopped', 'handoff'] as const
    for (const status of statuses) {
      expect(zh[statusKey(status)]).toEqual(expect.any(String))
      expect(zh[statusKey(status)].length).toBeGreaterThan(0)
    }
  })

  it('maps every stop reason, handoff reason, and event kind to copy', () => {
    expect(zh[stopReasonKey('cancelled')]).toBe('人工取消')
    expect(zh[stopReasonKey('budget-exhausted')]).toBe('预算耗尽')
    expect(zh[stopReasonKey('no-progress')]).toBe('无进展')
    expect(zh[handoffReasonKey('journal-incomplete-tail')]).toBe('日志尾部不完整')
    expect(zh[handoffReasonKey('journal-corrupted')]).toBe('日志损坏')
    expect(zh[handoffReasonKey('attempt-interrupted')]).toBe('轮次被中断')
    expect(zh[handoffReasonKey('clock-uncertain')]).toBe('时钟不确定')
    const kinds: readonly SelfDevelopmentEventKind[] = ['turn-finished', 'failed', 'awaiting-decision', 'awaiting-trial', 'stopped']
    for (const kind of kinds) expect(zh[eventKindKey(kind)].length).toBeGreaterThan(0)
  })

  it('maps the facade error codes to fixed wording and falls back for core and unknown codes', () => {
    expect(zh[errorKey('self-development/disabled')]).toBe('自开发远端服务未启用（enabled: false）')
    expect(zh[errorKey('self-development/config-invalid')]).toBe('请求参数无效')
    expect(zh[errorKey('self-development/task-unknown')]).toBe('任务不存在')
    expect(zh[errorKey('self-development/actor-forbidden')]).toBe('当前操作者不在允许名单中')
    expect(zh[errorKey('self-development/presence-unconfirmed')]).toBe('缺少显式在场确认')
    expect(zh[errorKey('self-development/runner-unavailable')]).toBe('运行器插件未加载，无法启动轮次')
    // A core or runner rejection arrives as self-development/core; the generic
    // line carries its message verbatim.
    expect(errorKey('self-development/core')).toBe('errorGeneric')
    expect(errorKey('SOMETHING_ELSE')).toBe('errorGeneric')
  })

  it('maps every action to its panel label and dialog copy', () => {
    const actions: readonly ActionId[] = ['authorizePlanning', 'confirmPlan', 'approveBudget', 'runAttempt', 'stop', 'recordTrialApproval']
    for (const action of actions) {
      expect(zh[actionLabelKey(action)].length).toBeGreaterThan(0)
      expect(zh[dialogTitleKey(action)].length).toBeGreaterThan(0)
      expect(zh[dialogDetailKey(action)].length).toBeGreaterThan(0)
    }
  })

  it('shows the authorization buttons a status offers, and never an upgrade action', () => {
    expect(actionsFor('draft', false, false)).toEqual(['authorizePlanning'])
    expect(actionsFor('awaiting-plan-confirmation', true, false)).toEqual(['confirmPlan'])
    expect(actionsFor('awaiting-plan-confirmation', false, false)).toEqual([])
    expect(actionsFor('awaiting-development-approval', true, false)).toEqual(['approveBudget'])
    expect(actionsFor('ready', true, false)).toEqual(['runAttempt', 'stop'])
    expect(actionsFor('attempting', true, false)).toEqual(['stop'])
    expect(actionsFor('awaiting-trial', true, true)).toEqual(['recordTrialApproval'])
    expect(actionsFor('awaiting-trial', true, false)).toEqual([])
    expect(actionsFor('planning-authorized', false, false)).toEqual([])
    expect(actionsFor('stopped', false, false)).toEqual([])
    expect(actionsFor('handoff', false, false)).toEqual([])
  })
})
