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
import { detail, event, live, offline, projection, projectionWithout, scriptableApi, summary } from './fixtures.client.ts'

afterEach(cleanup)

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
      listTasks: vi.fn(async () => ({ ok: false as const, error: { code: 'SELF_DEV_REMOTE_DISABLED', message: 'x' } })),
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
      getTask: vi.fn(async () => ({ ok: false as const, error: { code: 'SELF_DEV_REMOTE_TASK_UNKNOWN', message: 'missing' } })),
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

    fireEvent.click(view.getByRole('button', { name: 'Filled in — go to confirmation' }))
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
      runAttempt: vi.fn(async () => ({ ok: false as const, error: { code: 'SELF_DEV_REMOTE_PRESENCE_UNCONFIRMED', message: 'no' } })),
    })
    const view = render(<SelfDevelopmentPanel {...props({ remote: api })} />)
    await openTask(view)
    fireEvent.change(document.getElementById('dsh-self-dev-actor')!, { target: { value: 'mima' } })
    fireEvent.change(document.getElementById('dsh-self-dev-worktree')!, { target: { value: '/w' } })
    fireEvent.change(document.getElementById('dsh-self-dev-artifacts')!, { target: { value: 'a.ts' } })
    fireEvent.change(document.getElementById('dsh-self-dev-acceptance')!, { target: { value: '/a.yml' } })
    fireEvent.click(view.getByLabelText('I am at the computer; this run is supervised'))
    fireEvent.click(view.getByRole('button', { name: 'Filled in — go to confirmation' }))
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

  it('renders the operation failure line when stopping is refused by the task state', async () => {
    const api = scriptableApi({
      stop: vi.fn(async () => ({ ok: false as const, error: { code: 'SELF_DEV_INVALID_STATE', message: 'busy' } })),
    })
    const view = render(<SelfDevelopmentPanel {...props({ remote: api })} />)
    await openTask(view)
    fireEvent.click(view.getByRole('button', { name: 'Stop' }))
    fireEvent.click(withinDialogConfirm(view, 'Stop task'))
    await vi.waitFor(() => { expect(view.getByText('The task\'s current state refuses this operation')).toBeDefined() })
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
      recentEvents: vi.fn(async () => ({ ok: false as const, error: { code: 'SELF_DEV_REMOTE_DISABLED', message: 'x' } })),
    })
    const view = render(<SelfDevelopmentPanel {...props({ remote: api })} />)
    await vi.waitFor(() => { expect(view.getByText('No round events yet')).toBeDefined() })
    expect(view.getByRole('list', { name: 'Self-development task list' })).toBeDefined()
  })

  it('renders the phone whitelist view: paths hidden, dataHome disabled, actions kept', async () => {
    const api = scriptableApi()
    const view = render(<SelfDevelopmentPanel {...props({ remote: api, phone: true })} />)
    await openTask(view)
    expect(view.getByText('A phone does not show experiment or evidence paths; view them on the stable side.')).toBeDefined()
    expect((document.getElementById('dsh-self-dev-datahome') as HTMLInputElement).disabled).toBe(true)
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
    fireEvent.click(view.getByRole('button', { name: 'Filled in — go to confirmation' }))
    fireEvent.click(withinDialogConfirm(view, 'Start one round'))
    await vi.waitFor(() => { expect(view.getByText('Experiment path: /experiments/wt-1')).toBeDefined() })

    fireEvent.click(view.getByRole('button', { name: 'Copy' }))
    await vi.waitFor(() => { expect(view.getByText('Copied')).toBeDefined() })
    expect(writeText).toHaveBeenCalledWith('/experiments/wt-1')
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
