// @vitest-environment jsdom
/**
 * The self-development panel: list and card rendering, the status-to-button
 * matrix, the second-confirmation flow of every write, the presence gate of
 * `runAttempt`, the evidence timeline, the not-enabled view, and the phone
 * whitelist presentation.
 */
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { en } from '../src/client/locales.ts'
import { SelfDevelopmentPanel } from '../src/client/SelfDevelopmentPanel.tsx'
import type { SelfDevelopmentPanelProps } from '../src/client/SelfDevelopmentPanel.tsx'
import type { SelfDevelopmentAvailability } from '../src/client/face.ts'
import type { Attempt } from '@deepseek-ai/dsh-workflow-self-development'
import { card, detail, event, launchProfile, live, offline, projection, projectionWithout, scriptableApi, summary } from './fixtures.client.ts'

afterEach(cleanup)
afterEach(() => { localStorage.clear() })

const t = makeTranslate(en)

/** Selector hook over the live availability fact: the default stand-in for the framework-bound hook. */
function useLiveAvailability<S>(select: (fact: SelfDevelopmentAvailability) => S): S {
  return select(live)
}

/** Selector hook over the offline availability fact, for the not-enabled view. */
function useOfflineAvailability<S>(select: (fact: SelfDevelopmentAvailability) => S): S {
  return select(offline)
}

function props(overrides: Partial<SelfDevelopmentPanelProps> = {}): SelfDevelopmentPanelProps {
  const availability = overrides.useAvailability ?? useLiveAvailability
  return {
    t,
    remote: scriptableApi(),
    phone: false,
    useAvailability: availability,
    ...overrides,
  }
}

async function openTask(view: ReturnType<typeof render>): Promise<void> {
  await vi.waitFor(() => { expect(view.getByRole('button', { name: 'Open task task-1' })).toBeDefined() })
  fireEvent.click(view.getByRole('button', { name: 'Open task task-1' }))
  await vi.waitFor(() => { expect(view.getByRole('region', { name: 'Confirmation card' })).toBeDefined() })
}

describe('SelfDevelopmentPanel', () => {
  it('renders the not-enabled view when the availability fact reports no mounted namespace', () => {
    const view = render(<SelfDevelopmentPanel {...props({ useAvailability: useOfflineAvailability })} />)
    expect(view.getByText('Self-development is not enabled')).toBeDefined()
    expect(view.getByText('ordinary chat never creates an authorization', { exact: false })).toBeDefined()
    expect(view.queryByRole('button', { name: 'Reload' })).toBeNull()
  })

  it('lists tasks with status badge and revision, and offers reload and refresh error copy', async () => {
    const api = scriptableApi({
      listTasks: vi.fn(async () => ({ ok: true as const, value: [summary(), summary({ taskId: 'task-2', status: 'attempting', revision: 7, title: '' })] })),
    })
    const view = render(<SelfDevelopmentPanel {...props({ remote: api })} />)
    await vi.waitFor(() => { expect(view.getByText('修复导出按钮')).toBeDefined() })
    expect(view.getByRole('list', { name: 'Self-development task list' })).toBeDefined()
    expect(view.getByText('Ready to launch')).toBeDefined()
    expect(view.getByText('Running')).toBeDefined()
    expect(view.getByText('Revision 7')).toBeDefined()
    expect(view.getByText('task-2')).toBeDefined()
    expect(api.listTasks).toHaveBeenCalledTimes(1)

    fireEvent.click(view.getByRole('button', { name: 'Reload' }))
    await vi.waitFor(() => { expect(api.listTasks).toHaveBeenCalledTimes(2) })
  })

  it('renders the list failure line when the read rejects', async () => {
    const api = scriptableApi({
      listTasks: vi.fn(async () => ({ ok: false as const, error: { code: 'self-development/disabled', message: 'x' } })),
    })
    const view = render(<SelfDevelopmentPanel {...props({ remote: api })} />)
    await vi.waitFor(() => { expect(view.getByText('The self-development remote service is disabled (enabled: false)')).toBeDefined() })
  })

  it('renders an empty list with the empty copy', async () => {
    const api = scriptableApi({ listTasks: vi.fn(async () => ({ ok: true as const, value: [] })) })
    const view = render(<SelfDevelopmentPanel {...props({ remote: api })} />)
    await vi.waitFor(() => { expect(view.getByText('No self-development tasks')).toBeDefined() })
  })

  it('renders the selected task\'s confirmation card and projection summary', async () => {
    const api = scriptableApi({
      getTask: vi.fn(async () => ({ ok: true as const, value: detail({
        projection: projection({
          status: 'awaiting-trial',
          currentAttempt: {
            attemptId: 'a-1', attemptNumber: 2, startedAt: { bootId: 'boot', monotonicMs: 1 },
            testPlanDigest: 'b'.repeat(64), sourceDigest: 'c'.repeat(64), artifactDigest: 'd'.repeat(64),
            capabilityDigest: 'e'.repeat(64), capabilitySource: 'human-presence',
          } as Attempt,
          verifiedResultDigest: 'f'.repeat(64),
          trialApproval: { approvedBy: 'mima', resultDigest: 'f'.repeat(64) },
          stopReason: 'no-progress',
          consumedRounds: 2, consumedTimeMs: 120000, revision: 6,
        }) }),
      })),
    })
    const view = render(<SelfDevelopmentPanel {...props({ remote: api })} />)
    await openTask(view)
    expect(view.getByText('为导出菜单补充一个批量导出入口')).toBeDefined()
    expect(view.getByText('Revision: 6 · Awaiting trial')).toBeDefined()
    expect(view.getByText('Attempt in flight: Round 2')).toBeDefined()
    expect(view.getByText(`Verified result digest: ${'f'.repeat(64)}`).textContent).toBeDefined()
    expect(view.getByText('Approved by mima')).toBeDefined()
    expect(view.getByText('Stop reason: No progress')).toBeDefined()
    expect(view.getByRole('button', { name: 'Record trial approval' })).toBeDefined()
  })

  it('renders the detail failure line when the task is unknown', async () => {
    const api = scriptableApi({
      getTask: vi.fn(async () => ({ ok: false as const, error: { code: 'self-development/task-unknown', message: 'missing' } })),
    })
    const view = render(<SelfDevelopmentPanel {...props({ remote: api })} />)
    await vi.waitFor(() => { expect(view.getByRole('button', { name: 'Open task task-1' })).toBeDefined() })
    fireEvent.click(view.getByRole('button', { name: 'Open task task-1' }))
    await vi.waitFor(() => { expect(view.getByText('The task does not exist')).toBeDefined() })
  })

  it('confirms planning only after the second confirmation, and cancellation calls nothing', async () => {
    const api = scriptableApi({
      getTask: vi.fn(async () => ({ ok: true as const, value: { ...detail(), projection: projectionWithout(projection({ status: 'draft' }), ['plan', 'spec']) } })),
    })
    const view = render(<SelfDevelopmentPanel {...props({ remote: api })} />)
    await openTask(view)
    expect(view.getByRole('button', { name: 'Authorize planning' })).toBeDefined()
    expect(view.queryByRole('button', { name: 'Start one round' })).toBeNull()

    // No actor typed yet: the action stays disabled.
    expect((view.getByRole('button', { name: 'Authorize planning' }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(document.getElementById('dsh-self-dev-actor')!, { target: { value: 'mima' } })
    fireEvent.click(view.getByRole('button', { name: 'Authorize planning' }))
    expect(view.getByRole('dialog', { name: 'Authorize planning' })).toBeDefined()
    fireEvent.click(withinDialogCancel(view, 'Authorize planning'))
    expect(view.queryByRole('dialog', { name: 'Authorize planning' })).toBeNull()
    expect(api.authorizePlanning).not.toHaveBeenCalled()

    fireEvent.click(view.getByRole('button', { name: 'Authorize planning' }))
    fireEvent.click(withinDialogConfirm(view, 'Authorize planning'))
    await vi.waitFor(() => { expect(api.authorizePlanning).toHaveBeenCalledWith('task-1', 3, 'mima') })
    await vi.waitFor(() => { expect(api.getTask).toHaveBeenCalledTimes(2) })
    expect(view.queryByRole('dialog', { name: 'Authorize planning' })).toBeNull()
  })

  it('gates starting a round behind the presence acknowledgement and never calls the remote before it', async () => {
    const api = scriptableApi()
    const view = render(<SelfDevelopmentPanel {...props({ remote: api })} />)
    await openTask(view)
    const start = view.getByRole('button', { name: 'Start one round' })
    expect((start as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(start)
    expect(api.runAttempt).not.toHaveBeenCalled()
    expect(view.queryByRole('dialog', { name: 'Start one round' })).toBeNull()
    expect(view.getByText('Check the presence acknowledgement to start.')).toBeDefined()
  })

  it('starts a round only after the presence checkbox and the dialog acknowledgement, passing explicit presence and form values', async () => {
    const api = scriptableApi()
    const view = render(<SelfDevelopmentPanel {...props({ remote: api })} />)
    await openTask(view)

    fireEvent.change(document.getElementById('dsh-self-dev-actor')!, { target: { value: 'mima' } })
    fireEvent.change(document.getElementById('dsh-self-dev-worktree')!, { target: { value: '/repo/.experiments/task-1' } })
    fireEvent.change(document.getElementById('dsh-self-dev-artifacts')!, { target: { value: 'apps/web/dist/a.js, ' } })
    fireEvent.change(document.getElementById('dsh-self-dev-acceptance')!, { target: { value: '/repo/acceptance.yml' } })
    fireEvent.change(document.getElementById('dsh-self-dev-datahome')!, { target: { value: '/repo/.experiments/task-1/dsh-home' } })
    fireEvent.change(document.getElementById('dsh-self-dev-ports')!, { target: { value: '5173' } })
    fireEvent.click(view.getByLabelText('I am at the computer; this run is supervised'))
    expect(view.getByText('Entered: /repo/.experiments/task-1')).toBeDefined()

    fireEvent.click(view.getByRole('button', { name: 'Start one round' }))
    expect(view.getByRole('dialog', { name: 'Start one round' })).toBeDefined()
    fireEvent.click(withinDialogConfirm(view, 'Start one round'))
    await vi.waitFor(() => {
      expect(api.runAttempt).toHaveBeenCalledWith({
        taskId: 'task-1', expectedRevision: 3,
        worktree: '/repo/.experiments/task-1',
        artifactPaths: ['apps/web/dist/a.js'],
        acceptancePath: '/repo/acceptance.yml',
        dataHome: '/repo/.experiments/task-1/dsh-home',
        confirmedBy: 'mima',
        loopbackAllowlist: [5173],
        presenceAcknowledged: true,
      })
    })
    expect(view.queryByRole('dialog', { name: 'Start one round' })).toBeNull()
    await vi.waitFor(() => { expect(view.getByText('Latest evidence path: /tmp/evidence')).toBeDefined() })
    expect(view.getByText('Experiment path: /experiments/wt-1')).toBeDefined()
  })

  it('shows the operation failure line when the launch is refused', async () => {
    const api = scriptableApi({
      runAttempt: vi.fn(async () => ({ ok: false as const, error: { code: 'self-development/presence-unconfirmed', message: 'no' } })),
    })
    const view = render(<SelfDevelopmentPanel {...props({ remote: api })} />)
    await openTask(view)
    fireEvent.change(document.getElementById('dsh-self-dev-actor')!, { target: { value: 'mima' } })
    fireEvent.change(document.getElementById('dsh-self-dev-worktree')!, { target: { value: '/w' } })
    fireEvent.change(document.getElementById('dsh-self-dev-artifacts')!, { target: { value: 'a.ts' } })
    fireEvent.change(document.getElementById('dsh-self-dev-acceptance')!, { target: { value: '/a.yml' } })
    fireEvent.click(view.getByLabelText('I am at the computer; this run is supervised'))
    fireEvent.click(view.getByRole('button', { name: 'Start one round' }))
    fireEvent.click(withinDialogConfirm(view, 'Start one round'))
    await vi.waitFor(() => { expect(view.getByText('The explicit presence acknowledgement is missing')).toBeDefined() })
  })

  it('records the trial approval through its confirmation dialog', async () => {
    const api = scriptableApi({
      getTask: vi.fn(async () => ({ ok: true as const, value: detail({ projection: projection({ status: 'awaiting-trial', verifiedResultDigest: 'f'.repeat(64) }) }) })),
    })
    const view = render(<SelfDevelopmentPanel {...props({ remote: api })} />)
    await openTask(view)
    expect((view.getByRole('button', { name: 'Record trial approval' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(document.getElementById('dsh-self-dev-actor')!, { target: { value: 'mima' } })
    fireEvent.click(view.getByRole('button', { name: 'Record trial approval' }))
    fireEvent.click(withinDialogConfirm(view, 'Record trial approval'))
    await vi.waitFor(() => { expect(api.recordTrialApproval).toHaveBeenCalledWith('task-1', 3, 'mima') })
  })

  it('stops a task without an actor through its confirmation dialog', async () => {
    const api = scriptableApi()
    const view = render(<SelfDevelopmentPanel {...props({ remote: api })} />)
    await openTask(view)
    fireEvent.click(view.getByRole('button', { name: 'Stop' }))
    fireEvent.click(withinDialogConfirm(view, 'Stop task'))
    await vi.waitFor(() => { expect(api.stop).toHaveBeenCalledWith('task-1', 3, 'cancelled') })
  })

  it('renders the generic failure line when stopping is refused by the task state', async () => {
    const api = scriptableApi({
      // A core rejection arrives as self-development/core; the generic line carries the wire text.
      stop: vi.fn(async () => ({ ok: false as const, error: { code: 'self-development/core', message: 'busy' } })),
    })
    const view = render(<SelfDevelopmentPanel {...props({ remote: api })} />)
    await openTask(view)
    fireEvent.click(view.getByRole('button', { name: 'Stop' }))
    fireEvent.click(withinDialogConfirm(view, 'Stop task'))
    await vi.waitFor(() => { expect(view.getByText('The operation failed: busy')).toBeDefined() })
  })

  it('confirms the plan from the awaiting-plan-confirmation status, showing the cases first', async () => {
    const api = scriptableApi({
      getTask: vi.fn(async () => ({ ok: true as const, value: detail({ projection: projection({ status: 'awaiting-plan-confirmation' }) }) })),
    })
    const view = render(<SelfDevelopmentPanel {...props({ remote: api })} />)
    await openTask(view)
    expect(view.getByText('导出按钮点击后生成文件')).toBeDefined()
    expect(view.getByText('深色模式下核对图标对比度')).toBeDefined()
    expect(view.queryByRole('button', { name: 'Start one round' })).toBeNull()
    fireEvent.change(document.getElementById('dsh-self-dev-actor')!, { target: { value: 'mima' } })
    fireEvent.click(view.getByRole('button', { name: 'Confirm plan' }))
    fireEvent.click(withinDialogConfirm(view, 'Confirm plan'))
    await vi.waitFor(() => {
      expect(api.confirmPlan).toHaveBeenCalledWith('task-1', 3, {
        testPlanId: 'plan-1', version: 2, taskSpecVersion: 1,
        requiredCases: [{ caseId: 'case-1', requirement: '导出按钮点击后生成文件', assertionIds: ['assert-1'] }],
        manualCases: ['深色模式下核对图标对比度'],
      }, 'mima')
    })
  })

  it('approves the budget through the explicit form and its confirmation dialog', async () => {
    const api = scriptableApi({
      getTask: vi.fn(async () => ({ ok: true as const, value: detail({ projection: projection({ status: 'awaiting-development-approval' }) }) })),
    })
    const view = render(<SelfDevelopmentPanel {...props({ remote: api })} />)
    await openTask(view)
    expect(view.getByText('Plan version (frozen): 2 · Spec version (frozen): 1')).toBeDefined()
    expect((view.getByRole('button', { name: 'Approve budget' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(document.getElementById('dsh-self-dev-actor')!, { target: { value: 'mima' } })
    fireEvent.change(document.getElementById('dsh-self-dev-mode')!, { target: { value: 'both' } })
    fireEvent.change(document.getElementById('dsh-self-dev-maxRounds')!, { target: { value: '4' } })
    fireEvent.change(document.getElementById('dsh-self-dev-durationMs')!, { target: { value: '600000' } })
    fireEvent.click(view.getByRole('button', { name: 'Approve budget' }))
    fireEvent.click(withinDialogConfirm(view, 'Approve budget'))
    await vi.waitFor(() => {
      expect(api.approveBudget).toHaveBeenCalledWith('task-1', 3, {
        mode: 'both', maxRounds: 4, durationMs: 600000,
        testPlanVersion: 2, taskSpecVersion: 1, approvedBy: 'mima',
      })
    })
  })

  it('refuses the budget approval without the frozen plan or spec instead of binding version 1', async () => {
    const api = scriptableApi({
      getTask: vi.fn(async () => ({ ok: true as const, value: {
        ...detail(),
        projection: projectionWithout(projection({ status: 'awaiting-development-approval' }), ['plan', 'spec']),
      } })),
    })
    const view = render(<SelfDevelopmentPanel {...props({ remote: api })} />)
    await openTask(view)
    expect(view.getByText('Plan version (frozen): (not set) · Spec version (frozen): (not set)')).toBeDefined()
    fireEvent.change(document.getElementById('dsh-self-dev-actor')!, { target: { value: 'mima' } })
    fireEvent.change(document.getElementById('dsh-self-dev-mode')!, { target: { value: 'rounds' } })
    fireEvent.change(document.getElementById('dsh-self-dev-maxRounds')!, { target: { value: '4' } })
    fireEvent.click(view.getByRole('button', { name: 'Filled in — go to confirmation' }))
    fireEvent.click(withinDialogConfirm(view, 'Approve budget'))
    await vi.waitFor(() => {
      expect(view.getByText('The frozen plan or spec is missing; the budget version cannot be bound.')).toBeDefined()
    })
    expect(api.approveBudget).not.toHaveBeenCalled()
  })

  it('renders the handoff reason and detail, and no action for a handoff task', async () => {
    const api = scriptableApi({
      getTask: vi.fn(async () => ({ ok: true as const, value: {
        ...detail(),
        projection: projectionWithout(projection({
          status: 'handoff',
          handoffReason: 'attempt-interrupted', handoffDetail: '轮次进程被中断，现场保留',
        }), ['plan']),
      } })),
    })
    const view = render(<SelfDevelopmentPanel {...props({ remote: api })} />)
    await openTask(view)
    expect(view.getByText('Handoff reason: Attempt interrupted')).toBeDefined()
    expect(view.getByText('Handoff detail: 轮次进程被中断，现场保留')).toBeDefined()
    expect(view.getByRole('button', { name: 'Copy' })).toBeDefined()
  })

  it('renders a handoff reason without a detail line', async () => {
    const api = scriptableApi({
      getTask: vi.fn(async () => ({ ok: true as const, value: {
        ...detail(),
        projection: projectionWithout(projection({ status: 'handoff', handoffReason: 'journal-corrupted' }), ['plan', 'handoffDetail']),
      } })),
    })
    const view = render(<SelfDevelopmentPanel {...props({ remote: api })} />)
    await openTask(view)
    expect(view.getByText('Handoff reason: Journal corrupted')).toBeDefined()
    expect(view.queryByText('Handoff detail: 轮次进程被中断，现场保留')).toBeNull()
  })

  it('renders the timeline from the facade\'s recentEvents read and refreshes it with the list', async () => {
    const api = scriptableApi({
      recentEvents: vi.fn(async () => ({ ok: true as const, value: [event()] })),
    })
    const view = render(<SelfDevelopmentPanel {...props({ remote: api })} />)
    await vi.waitFor(() => { expect(view.getByText('第 1 轮结束')).toBeDefined() })
    await vi.waitFor(() => { expect(api.recentEvents).toHaveBeenCalledTimes(1) })

    fireEvent.click(view.getByRole('button', { name: 'Reload' }))
    await vi.waitFor(() => { expect(api.recentEvents).toHaveBeenCalledTimes(2) })
    expect(view.getByText('Round finished')).toBeDefined()
  })

  it('keeps the timeline area with the empty copy when the facade reports no events', async () => {
    const view = render(<SelfDevelopmentPanel {...props()} />)
    await vi.waitFor(() => { expect(view.getByText('No round events yet')).toBeDefined() })
  })

  it('keeps the timeline area with the empty copy when the recentEvents read fails', async () => {
    const api = scriptableApi({
      recentEvents: vi.fn(async () => ({ ok: false as const, error: { code: 'self-development/disabled', message: 'x' } })),
    })
    const view = render(<SelfDevelopmentPanel {...props({ remote: api })} />)
    await vi.waitFor(() => { expect(view.getByText('No round events yet')).toBeDefined() })
    expect(view.getByRole('list', { name: 'Self-development task list' })).toBeDefined()
  })

  it('renders the phone whitelist view: paths hidden, launch host-only, actions kept', async () => {
    const api = scriptableApi()
    const view = render(<SelfDevelopmentPanel {...props({ remote: api, phone: true })} />)
    await openTask(view)
    expect(view.getByText('A phone does not show experiment or evidence paths; view them on the stable side.')).toBeDefined()
    expect(view.getByText('This operation can only be completed at the computer; a phone can view, confirm, and stop only')).toBeDefined()
    expect(document.getElementById('dsh-self-dev-worktree')).toBeNull()
    expect(view.queryByRole('button', { name: 'Start one round' })).toBeNull()
    expect(view.getByRole('button', { name: 'Stop' })).toBeDefined()
  })

  it('copies the launched attempt\'s experiment path from the runAttempt outcome through the clipboard fallback', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    const api = scriptableApi()
    const view = render(<SelfDevelopmentPanel {...props({ remote: api })} />)
    await openTask(view)
    expect(view.getByText('Experiment path: (not set)')).toBeDefined()
    fireEvent.click(view.getByRole('button', { name: 'Copy' }))
    expect(writeText).not.toHaveBeenCalled()
    expect(view.queryByText('Copied')).toBeNull()

    fireEvent.change(document.getElementById('dsh-self-dev-actor')!, { target: { value: 'mima' } })
    fireEvent.change(document.getElementById('dsh-self-dev-worktree')!, { target: { value: '/repo/.experiments/task-1' } })
    fireEvent.change(document.getElementById('dsh-self-dev-artifacts')!, { target: { value: 'a.ts' } })
    fireEvent.change(document.getElementById('dsh-self-dev-acceptance')!, { target: { value: '/a.yml' } })
    fireEvent.click(view.getByLabelText('I am at the computer; this run is supervised'))
    fireEvent.click(view.getByRole('button', { name: 'Start one round' }))
    fireEvent.click(withinDialogConfirm(view, 'Start one round'))
    await vi.waitFor(() => { expect(view.getByText('Experiment path: /experiments/wt-1')).toBeDefined() })

    fireEvent.click(view.getByRole('button', { name: 'Copy' }))
    await vi.waitFor(() => { expect(view.getByText('Copied')).toBeDefined() })
    expect(writeText).toHaveBeenCalledWith('/experiments/wt-1')
  })

  it('launches one click from the stored profile: no advanced inputs, presence gate, exactly the three launch keys', async () => {
    const api = scriptableApi({
      getTask: vi.fn(async () => ({ ok: true as const, value: detail({ card: card({ launchProfile: launchProfile() }) }) })),
    })
    const view = render(<SelfDevelopmentPanel {...props({ remote: api })} />)
    await openTask(view)
    expect(view.getByText('Experiment worktree path: /experiments/wt-1')).toBeDefined()
    expect(view.getByText('Confirmed by: mima')).toBeDefined()
    expect(document.getElementById('dsh-self-dev-worktree')).toBeNull()

    const start = view.getByRole('button', { name: 'Start one round' })
    expect((start as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(start)
    expect(api.runAttempt).not.toHaveBeenCalled()
    expect(view.queryByRole('dialog', { name: 'Start one round' })).toBeNull()

    fireEvent.click(view.getByLabelText('I am at the computer; this run is supervised'))
    fireEvent.click(start)
    const dialog = view.getByRole('dialog', { name: 'Start one round' })
    expect(dialog.textContent).toContain('/experiments/wt-1')
    expect(dialog.textContent).toContain('/repo/acceptance.yml')
    expect(dialog.textContent).toContain('mima')
    fireEvent.click(withinDialogConfirm(view, 'Start one round'))
    await vi.waitFor(() => { expect(api.runAttempt).toHaveBeenCalledTimes(1) })
    expect(api.runAttempt).toHaveBeenCalledWith({ taskId: 'task-1', expectedRevision: 3, presenceAcknowledged: true })
  })

  it('carries an advanced worktree override over the stored profile and nothing else', async () => {
    const api = scriptableApi({
      getTask: vi.fn(async () => ({ ok: true as const, value: detail({ card: card({ launchProfile: launchProfile() }) }) })),
    })
    const view = render(<SelfDevelopmentPanel {...props({ remote: api })} />)
    await openTask(view)
    fireEvent.click(view.getByRole('button', { name: 'Advanced (override profile)' }))
    fireEvent.change(document.getElementById('dsh-self-dev-worktree')!, { target: { value: ' /experiments/other ' } })
    fireEvent.click(view.getByLabelText('I am at the computer; this run is supervised'))
    fireEvent.click(view.getByRole('button', { name: 'Start one round' }))
    fireEvent.click(withinDialogConfirm(view, 'Start one round'))
    await vi.waitFor(() => {
      expect(api.runAttempt).toHaveBeenCalledWith({
        taskId: 'task-1', expectedRevision: 3, worktree: '/experiments/other', presenceAcknowledged: true,
      })
    })
  })

  it('expands the advanced area and offers saving a profile when the task has none', async () => {
    const api = scriptableApi()
    const view = render(<SelfDevelopmentPanel {...props({ remote: api })} />)
    await openTask(view)
    expect(view.getByText('This task has no launch profile; fill in the fields or set the profile first.')).toBeDefined()
    expect(document.getElementById('dsh-self-dev-worktree')).toBeDefined()

    // Without both required paths the save button stays disabled.
    expect((view.getByRole('button', { name: 'Save as profile' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(document.getElementById('dsh-self-dev-worktree')!, { target: { value: '/experiments/wt-9' } })
    expect((view.getByRole('button', { name: 'Save as profile' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(document.getElementById('dsh-self-dev-worktree')!, { target: { value: '' } })
    fireEvent.click(view.getByRole('button', { name: 'Save as profile' }))
    expect(api.setLaunchProfile).not.toHaveBeenCalled()

    fireEvent.change(document.getElementById('dsh-self-dev-worktree')!, { target: { value: '/experiments/wt-9' } })
    fireEvent.change(document.getElementById('dsh-self-dev-acceptance')!, { target: { value: '/repo/acceptance.yml' } })
    fireEvent.change(document.getElementById('dsh-self-dev-datahome')!, { target: { value: '/repo/.experiments/home' } })
    fireEvent.change(document.getElementById('dsh-self-dev-ports')!, { target: { value: '5173' } })
    fireEvent.change(document.getElementById('dsh-self-dev-actor')!, { target: { value: 'k3' } })
    fireEvent.click(view.getByRole('button', { name: 'Save as profile' }))
    await vi.waitFor(() => {
      expect(api.setLaunchProfile).toHaveBeenCalledWith('task-1', {
        worktree: '/experiments/wt-9',
        acceptancePath: '/repo/acceptance.yml',
        dataHome: '/repo/.experiments/home',
        loopbackAllowlist: [5173],
        confirmedBy: 'k3',
      })
    })
  })

  it('lists the unset launch values in the confirm dialog when no profile exists', async () => {
    const api = scriptableApi()
    const view = render(<SelfDevelopmentPanel {...props({ remote: api })} />)
    await openTask(view)
    fireEvent.click(view.getByLabelText('I am at the computer; this run is supervised'))
    fireEvent.click(view.getByRole('button', { name: 'Start one round' }))
    const dialog = view.getByRole('dialog', { name: 'Start one round' })
    expect(dialog.textContent).toContain('(not set)')
    fireEvent.click(withinDialogCancel(view, 'Start one round'))
    expect(api.runAttempt).not.toHaveBeenCalled()
  })

  it('shows the operation failure line when creating a task is refused', async () => {
    const api = scriptableApi({
      createTask: vi.fn(async () => ({ ok: false as const, error: { code: 'self-development/config-invalid', message: 'digest' } })),
    })
    const view = render(<SelfDevelopmentPanel {...props({ remote: api })} />)
    await vi.waitFor(() => { expect(view.getByRole('button', { name: 'New task' })).toBeDefined() })
    fireEvent.click(view.getByRole('button', { name: 'New task' }))
    fireEvent.change(document.getElementById('dsh-self-dev-new-task-id')!, { target: { value: 'task-2' } })
    fireEvent.change(document.getElementById('dsh-self-dev-new-requirement')!, { target: { value: 'r' } })
    fireEvent.change(document.getElementById('dsh-self-dev-new-scope')!, { target: { value: 'a/**' } })
    fireEvent.change(document.getElementById('dsh-self-dev-new-baseline')!, { target: { value: 'a'.repeat(64) } })
    fireEvent.change(document.getElementById('dsh-self-dev-new-created-by')!, { target: { value: 'mima' } })
    fireEvent.click(view.getByRole('button', { name: 'Create task' }))
    await vi.waitFor(() => { expect(view.getByText('The request arguments are invalid')).toBeDefined() })
  })

  it('shows the host-only failure copy when storing the profile is refused from a phone-class caller', async () => {
    const api = scriptableApi({
      setLaunchProfile: vi.fn(async () => ({ ok: false as const, error: { code: 'self-development/host-only-field', message: 'no' } })),
    })
    const view = render(<SelfDevelopmentPanel {...props({ remote: api })} />)
    await openTask(view)
    fireEvent.change(document.getElementById('dsh-self-dev-worktree')!, { target: { value: '/w' } })
    fireEvent.change(document.getElementById('dsh-self-dev-acceptance')!, { target: { value: '/a.yml' } })
    fireEvent.click(view.getByRole('button', { name: 'Save as profile' }))
    await vi.waitFor(() => {
      expect(view.getByText('This operation can only be completed at the computer; a phone can view, confirm, and stop only')).toBeDefined()
    })
  })

  it('disables recording the trial approval and names the approver once a trial approval exists', async () => {
    const api = scriptableApi({
      getTask: vi.fn(async () => ({ ok: true as const, value: detail({
        projection: projection({
          status: 'awaiting-trial',
          verifiedResultDigest: 'f'.repeat(64),
          trialApproval: { approvedBy: 'mima', resultDigest: 'f'.repeat(64) },
        }),
      }) })),
    })
    const view = render(<SelfDevelopmentPanel {...props({ remote: api })} />)
    await openTask(view)
    expect(view.getByText('Already approved (approved by mima)')).toBeDefined()
    fireEvent.change(document.getElementById('dsh-self-dev-actor')!, { target: { value: 'mima' } })
    expect((view.getByRole('button', { name: 'Record trial approval' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(view.getByRole('button', { name: 'Record trial approval' }))
    expect(api.recordTrialApproval).not.toHaveBeenCalled()
  })

  it('creates a task from the new-task form without a profile and remembers the creator', async () => {
    const api = scriptableApi()
    const view = render(<SelfDevelopmentPanel {...props({ remote: api })} />)
    await vi.waitFor(() => { expect(view.getByRole('button', { name: 'New task' })).toBeDefined() })
    fireEvent.click(view.getByRole('button', { name: 'New task' }))
    expect((view.getByRole('button', { name: 'Create task' }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(document.getElementById('dsh-self-dev-new-task-id')!, { target: { value: 'task-2' } })
    fireEvent.change(document.getElementById('dsh-self-dev-new-requirement')!, { target: { value: '补充批量导出' } })
    fireEvent.change(document.getElementById('dsh-self-dev-new-scope')!, { target: { value: 'apps/web/src/**' } })
    fireEvent.change(document.getElementById('dsh-self-dev-new-baseline')!, { target: { value: 'a'.repeat(64) } })
    fireEvent.change(document.getElementById('dsh-self-dev-new-created-by')!, { target: { value: 'mima' } })
    fireEvent.click(view.getByRole('button', { name: 'Create task' }))
    await vi.waitFor(() => { expect(api.createTask).toHaveBeenCalledTimes(1) })
    await vi.waitFor(() => { expect(api.listTasks).toHaveBeenCalledTimes(2) })
    expect(api.createTask).toHaveBeenCalledWith({
      taskId: 'task-2', version: 1, requirement: '补充批量导出',
      allowedModificationScope: ['apps/web/src/**'], stableBaselineDigest: 'a'.repeat(64), createdBy: 'mima',
    }, 0)
    expect(localStorage.getItem('dsh-self-dev-created-by')).toBe('mima')

    // A fresh form remembers the last creator.
    cleanup()
    const reopened = render(<SelfDevelopmentPanel {...props({ remote: api })} />)
    fireEvent.click(reopened.getByRole('button', { name: 'New task' }))
    expect((document.getElementById('dsh-self-dev-new-created-by') as HTMLInputElement).value).toBe('mima')
  })

  it('creates a task with the optional launch profile as the third argument', async () => {
    const api = scriptableApi()
    const view = render(<SelfDevelopmentPanel {...props({ remote: api })} />)
    await vi.waitFor(() => { expect(view.getByRole('button', { name: 'New task' })).toBeDefined() })
    fireEvent.click(view.getByRole('button', { name: 'New task' }))
    fireEvent.change(document.getElementById('dsh-self-dev-new-task-id')!, { target: { value: 'task-3' } })
    fireEvent.change(document.getElementById('dsh-self-dev-new-requirement')!, { target: { value: 'r' } })
    fireEvent.change(document.getElementById('dsh-self-dev-new-scope')!, { target: { value: 'a/**' } })
    fireEvent.change(document.getElementById('dsh-self-dev-new-baseline')!, { target: { value: 'b'.repeat(64) } })
    fireEvent.change(document.getElementById('dsh-self-dev-new-created-by')!, { target: { value: 'k3' } })
    fireEvent.change(document.getElementById('dsh-self-dev-new-profile-worktree')!, { target: { value: '/experiments/wt-3' } })
    fireEvent.change(document.getElementById('dsh-self-dev-new-profile-acceptance')!, { target: { value: '/repo/acceptance.yml' } })
    fireEvent.change(document.getElementById('dsh-self-dev-new-profile-artifacts')!, { target: { value: 'dist/a.js, dist/b.js' } })
    fireEvent.click(view.getByRole('button', { name: 'Create task' }))
    await vi.waitFor(() => { expect(api.createTask).toHaveBeenCalledTimes(1) })
    expect(api.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-3' }),
      0,
      { worktree: '/experiments/wt-3', acceptancePath: '/repo/acceptance.yml', artifactPaths: ['dist/a.js', 'dist/b.js'] },
    )
  })

  it('submits a multi-case plan draft from the planning-authorized form', async () => {
    const api = scriptableApi({
      getTask: vi.fn(async () => ({ ok: true as const, value: detail({ projection: projection({ status: 'planning-authorized' }) }) })),
    })
    const view = render(<SelfDevelopmentPanel {...props({ remote: api })} />)
    await openTask(view)
    expect(view.getByRole('region', { name: 'Submit plan draft' })).toBeDefined()
    expect((view.getByRole('button', { name: 'Submit plan draft' }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(document.getElementById('dsh-self-dev-case-id-0')!, { target: { value: 'case-1' } })
    fireEvent.change(document.getElementById('dsh-self-dev-case-requirement-0')!, { target: { value: '导出生成文件' } })
    fireEvent.change(document.getElementById('dsh-self-dev-case-assertions-0')!, { target: { value: 'assert-1, assert-2' } })
    fireEvent.click(view.getByRole('button', { name: 'Add case' }))
    fireEvent.change(document.getElementById('dsh-self-dev-case-id-1')!, { target: { value: 'case-2' } })
    fireEvent.change(document.getElementById('dsh-self-dev-case-requirement-1')!, { target: { value: '深色模式可读' } })
    fireEvent.change(document.getElementById('dsh-self-dev-manual-cases')!, { target: { value: '人工核对图标, 人工核对打印' } })
    fireEvent.click(view.getByRole('button', { name: 'Submit plan draft' }))
    await vi.waitFor(() => { expect(api.submitPlanDraft).toHaveBeenCalledTimes(1) })
    expect(api.submitPlanDraft).toHaveBeenCalledWith('task-1', 3, {
      requiredCases: [
        { caseId: 'case-1', requirement: '导出生成文件', assertionIds: ['assert-1', 'assert-2'] },
        { caseId: 'case-2', requirement: '深色模式可读', assertionIds: [] },
      ],
      manualCases: ['人工核对图标', '人工核对打印'],
    })
  })

  it('removes a drafted case row and keeps the submit enabled for the remaining row', async () => {
    const api = scriptableApi({
      getTask: vi.fn(async () => ({ ok: true as const, value: detail({ projection: projection({ status: 'planning-authorized' }) }) })),
    })
    const view = render(<SelfDevelopmentPanel {...props({ remote: api })} />)
    await openTask(view)
    fireEvent.change(document.getElementById('dsh-self-dev-case-id-0')!, { target: { value: 'case-1' } })
    fireEvent.change(document.getElementById('dsh-self-dev-case-requirement-0')!, { target: { value: '导出生成文件' } })
    fireEvent.click(view.getByRole('button', { name: 'Add case' }))
    const removeSecond = view.getAllByRole('button', { name: 'Remove case' })[1]!
    fireEvent.click(removeSecond)
    await vi.waitFor(() => { expect(view.container.querySelector('#dsh-self-dev-case-id-1')).toBeNull() })
    fireEvent.click(view.getByRole('button', { name: 'Submit plan draft' }))
    await vi.waitFor(() => { expect(api.submitPlanDraft).toHaveBeenCalledWith('task-1', 3, {
      requiredCases: [{ caseId: 'case-1', requirement: '导出生成文件', assertionIds: [] }],
      manualCases: [],
    }) })
  })

  it('renders the unset budget line when the card carries no budget terms', async () => {
    const api = scriptableApi({
      getTask: vi.fn(async () => ({ ok: true as const, value: detail({ card: card({ budget: {} }) }) })),
    })
    const view = render(<SelfDevelopmentPanel {...props({ remote: api })} />)
    await openTask(view)
    expect(view.getByText('Budget: (not set)')).toBeDefined()
  })

  it('keeps the panel single-column at 480px through the stylesheet media query', () => {
    const source = readFileSync(resolve(process.cwd(), 'packages/client/ui-self-development/src/client/SelfDevelopmentPanel.module.css'), 'utf8')
    expect(source).toContain('@media (max-width: 480px)')
    const view = render(<SelfDevelopmentPanel {...props()} />)
    expect(view.container.firstElementChild).toMatchSnapshot()
  })
})

/** Check the dialog's acknowledgement and click its confirm button by the dialog's title. */
function withinDialogConfirm(view: ReturnType<typeof render>, title: string): HTMLElement {
  const dialog = view.getByRole('dialog', { name: title })
  const acknowledge = dialog.querySelector('input[type="checkbox"]')
  if (acknowledge === null) throw new Error(`no acknowledgement checkbox in dialog ${title}`)
  fireEvent.click(acknowledge)
  const confirm = [...dialog.querySelectorAll('button')].find(button => button.textContent === 'Confirm')
  if (confirm === undefined) throw new Error(`no confirm button in dialog ${title}`)
  return confirm
}

/** Click the dialog's cancel button by the dialog's title. */
function withinDialogCancel(view: ReturnType<typeof render>, title: string): HTMLElement {
  const dialog = view.getByRole('dialog', { name: title })
  const cancel = [...dialog.querySelectorAll('button')].find(button => button.textContent === 'Cancel')
  if (cancel === undefined) throw new Error(`no cancel button in dialog ${title}`)
  return cancel
}
