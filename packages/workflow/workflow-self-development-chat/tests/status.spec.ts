/**
 * The status and stop projections: the task summary, campaign state, evidence
 * paths, trial URL, and latest campaign event, plus the failure views. The
 * facade and trial ports are fakes.
 * @module status.spec
 */

import { describe, expect, it } from 'vitest'
import { buildStatusReport, stopTask } from '../src/status.ts'
import type { StatusDeps } from '../src/status.ts'
import type { CampaignEvent, CampaignState, SelfDevelopmentRemoteFacade, TaskDetailView, TrialPort } from '../src/types.ts'

/** Standard campaign state returned by the fake facade. */
const CAMPAIGN: CampaignState = {
  taskId: 'task-1',
  status: 'running',
  startedAt: 1,
  updatedAt: 9,
  rounds: 3,
  lastAttemptId: 'attempt-2',
  lastOutcome: 'failed',
  acknowledgement: 'unattended-accepted',
}

/** A facade fake answering getTask, campaign, and stopCampaign. */
class FakeFacade implements SelfDevelopmentRemoteFacade {
  getTaskError: Error | undefined
  campaignError: Error | undefined
  stopCalls: { taskId: string; reason: string }[] = []

  async createTask(): Promise<never> {
    throw new Error('not used in status tests')
  }

  async authorizePlanning(): Promise<never> {
    throw new Error('not a status test concern')
  }

  async submitPlanDraft(): Promise<never> {
    throw new Error('not a status test concern')
  }

  async confirmPlan(): Promise<never> {
    throw new Error('not a status test concern')
  }

  async approveBudget(): Promise<never> {
    throw new Error('not a status test concern')
  }

  async startCampaign(): Promise<never> {
    throw new Error('not a status test concern')
  }

  async recordTrialApproval(): Promise<never> {
    throw new Error('not a status test concern')
  }

  async campaign(taskId: string): Promise<CampaignState | undefined> {
    if (this.campaignError !== undefined) throw this.campaignError
    return taskId === 'task-1' ? CAMPAIGN : undefined
  }

  /** What `stopCampaign` answers; a settled campaign comes back unchanged, as the real facade does. */
  stopCampaignStatus: CampaignState['status'] = 'stopped'
  taskStopCalls: { taskId: string; expectedRevision: number }[] = []
  /** Status `getTask` reports for task-1; the stop path stops the task itself only when this is not terminal. */
  taskStatus = 'attempting'

  async stopCampaign(taskId: string, reason: string): Promise<CampaignState> {
    this.stopCalls.push({ taskId, reason })
    return this.stopCampaignStatus === 'stopped'
      ? { ...CAMPAIGN, taskId, status: 'stopped', reason }
      : { ...CAMPAIGN, taskId, status: this.stopCampaignStatus }
  }

  async stop(
    taskId: string,
    expectedRevision: number,
  ): Promise<{ taskId: string; operationId: string; revision: number; replayed: boolean }> {
    this.taskStopCalls.push({ taskId, expectedRevision })
    return { taskId, operationId: 'op-stop', revision: expectedRevision + 1, replayed: false }
  }

  async getTask(taskId: string): Promise<TaskDetailView> {
    if (this.getTaskError !== undefined) throw this.getTaskError
    return taskId === 'task-1'
      ? {
        projection: {
          status: this.taskStatus,
          revision: 7,
          spec: { requirement: 'add search' },
          consumedRounds: 3,
          consumedTimeMs: 4000,
          planningAuthorized: true,
          noProgressCount: 1,
        },
        card: {
          launchProfile: {
            worktree: '/exp/task-1',
            acceptancePath: '/control/acceptance/task-1.json',
            dataHome: '/exp/task-1/.data',
          },
        },
      }
      : {
        projection: {
          status: 'ready',
          revision: 1,
          spec: undefined,
          consumedRounds: 0,
          consumedTimeMs: 0,
          planningAuthorized: false,
          noProgressCount: 0,
        },
        card: { launchProfile: undefined },
      }
  }
}

/** Trial fake with a configurable instance list and failure. */
class FakeTrial implements TrialPort {
  instances: { taskId: string; url: string; port: number; startedAt: number }[] = []
  fail = false

  async trials(): Promise<{ taskId: string; url: string; port: number; startedAt: number }[]> {
    if (this.fail) throw new Error('trial service is down')
    return this.instances
  }

  /** Not exercised by the status report (release paths are covered by cleanup.spec.ts). */
  async closeTrial(taskId: string): Promise<void> {
    this.instances = this.instances.filter(instance => instance.taskId !== taskId)
  }

  /** Task ids `pending()` reports; `undefined` removes the method, as an older trial service would. */
  building: string[] | undefined = []
  pendingFails = false

  async pending(): Promise<readonly string[]> {
    if (this.pendingFails) throw new Error('trial service is down')
    return this.building ?? []
  }
}

/** The event the events service delivered for the task. */
const EVENT: CampaignEvent = {
  taskId: 'task-1',
  kind: 'awaiting-trial', origin: 'campaign',
  title: 'Campaign passed after round 3',
  occurredAt: 1234,
}

/** Assemble the status deps over the fakes. */
function makeDeps(): { deps: StatusDeps; facade: FakeFacade; trial: FakeTrial } {
  const facade = new FakeFacade()
  const trial = new FakeTrial()
  trial.instances.push({ taskId: 'task-1', url: 'http://127.0.0.1:4173/?token=t', port: 4173, startedAt: 1 })
  const deps: StatusDeps = {
    facade,
    trial,
    config: { controlDirectory: '/control' },
    latestEvents: new Map([['task-1', EVENT]]),
  }
  return { deps, facade, trial }
}

describe('buildStatusReport', () => {
  it('projects the task summary, campaign, paths, trial URL, and latest event', async () => {
    const { deps } = makeDeps()
    const report = await buildStatusReport(deps, 'task-1')
    expect(report).toEqual({
      ok: true,
      task: {
        status: 'attempting',
        revision: 7,
        requirement: 'add search',
        consumedRounds: 3,
        consumedTimeMs: 4000,
        planningAuthorized: true,
        noProgressCount: 1,
      },
      campaign: CAMPAIGN,
      paths: {
        worktree: '/exp/task-1',
        acceptancePath: '/control/acceptance/task-1.json',
        dataHome: '/exp/task-1/.data',
        campaignRecord: '/control/campaigns/task-1.json',
      },
      trialUrl: 'http://127.0.0.1:4173/?token=t',
      latestEvent: { kind: 'awaiting-trial', title: 'Campaign passed after round 3', occurredAt: 1234 },
    })
  })

  it('reports without a campaign, launch profile, trial, or event', async () => {
    const { deps } = makeDeps()
    const report = await buildStatusReport(deps, 'task-2')
    expect(report.ok).toBe(true)
    if (!report.ok) return
    expect(report.campaign).toBeUndefined()
    expect(report.paths.worktree).toBeUndefined()
    expect(report.paths.dataHome).toBeUndefined()
    expect(report.trialUrl).toBeUndefined()
    expect(report.latestEvent).toBeUndefined()
  })

  it('reports without a trial service and keeps working when the campaign lookup fails', async () => {
    const { deps, facade } = makeDeps()
    facade.campaignError = new Error('facade restart')
    const report = await buildStatusReport({ ...deps, trial: undefined }, 'task-1')
    expect(report.ok).toBe(true)
    if (!report.ok) return
    expect(report.campaign).toBeUndefined()
    expect(report.trialUrl).toBeUndefined()
  })

  it('ignores a trial-service failure and reports no trial URL', async () => {
    const { trial, deps } = makeDeps()
    trial.fail = true
    const report = await buildStatusReport(deps, 'task-1')
    expect(report.ok).toBe(true)
    if (!report.ok) return
    expect(report.trialUrl).toBeUndefined()
  })

  it('reports a trial that is still building, and only while no ready URL exists', async () => {
    const { trial, deps } = makeDeps()
    trial.instances = []
    trial.building = ['task-1']
    const building = await buildStatusReport(deps, 'task-1')
    expect(building.ok && building.trialState).toBe('building')
    expect(building.ok && building.trialUrl).toBeUndefined()
    // A ready instance wins: the pending list is not consulted.
    trial.instances = [{ taskId: 'task-1', url: 'http://127.0.0.1:8980/?token=t', port: 8980, startedAt: 1 }]
    const ready = await buildStatusReport(deps, 'task-1')
    expect(ready.ok && ready.trialUrl).toBe('http://127.0.0.1:8980/?token=t')
    expect(ready.ok && ready.trialState).toBeUndefined()
  })

  it('treats a trial service without pending(), or whose pending() fails, as not building', async () => {
    const { trial, deps } = makeDeps()
    trial.instances = []
    trial.pendingFails = true
    const failing = await buildStatusReport(deps, 'task-1')
    expect(failing.ok && failing.trialState).toBeUndefined()
    const older = { trials: async () => [], closeTrial: async () => {} }
    const report = await buildStatusReport({ ...deps, trial: older }, 'task-1')
    expect(report.ok && report.trialState).toBeUndefined()
  })

  it('fails with the facade error when getTask rejects', async () => {
    const { facade, deps } = makeDeps()
    facade.getTaskError = Object.assign(new Error('unknown task'), { code: 'self-development/task-not-found' })
    const report = await buildStatusReport(deps, 'task-9')
    expect(report).toMatchObject({
      ok: false,
      reason: 'status lookup for task task-9 failed',
      error: { code: 'self-development/task-not-found', message: 'unknown task' },
      paths: { acceptancePath: '/control/acceptance/task-9.json', campaignRecord: '/control/campaigns/task-9.json' },
    })
  })
})

describe('stopTask', () => {
  it('forwards the reason and projects the stopped campaign, stopping the task too once the campaign is not running', async () => {
    const { facade, deps } = makeDeps()
    const outcome = await stopTask(deps, 'task-1', 'user asked to stop')
    expect(outcome).toEqual({
      ok: true,
      campaign: { ...CAMPAIGN, status: 'stopped', reason: 'user asked to stop' },
      task: { status: 'stopped', revision: 8 },
    })
    expect(facade.stopCalls).toEqual([{ taskId: 'task-1', reason: 'user asked to stop' }])
    expect(facade.taskStopCalls).toEqual([{ taskId: 'task-1', expectedRevision: 7 }])
  })

  it('discards a passed, awaiting-trial task: the settled campaign is left as is and the task is stopped', async () => {
    const { facade, deps } = makeDeps()
    facade.stopCampaignStatus = 'passed'
    facade.taskStatus = 'awaiting-trial'
    const outcome = await stopTask(deps, 'task-1', 'not wanted after all')
    expect(outcome.ok).toBe(true)
    expect(outcome.campaign?.status).toBe('passed')
    expect(outcome.task).toEqual({ status: 'stopped', revision: 8 })
    expect(facade.taskStopCalls).toEqual([{ taskId: 'task-1', expectedRevision: 7 }])
  })

  it('leaves the task alone while its campaign is still running, or when it is already stopped', async () => {
    const { facade, deps } = makeDeps()
    facade.stopCampaignStatus = 'running'
    const running = await stopTask(deps, 'task-1', 'x')
    expect(running).toEqual({ ok: true, campaign: { ...CAMPAIGN, status: 'running' } })
    facade.stopCampaignStatus = 'stopped'
    facade.taskStatus = 'stopped'
    const already = await stopTask(deps, 'task-1', 'x')
    expect(already.task).toBeUndefined()
    expect(facade.taskStopCalls).toEqual([])
  })

  it('fails with the facade error when the stop is refused', async () => {
    const { deps } = makeDeps()
    deps.facade.stopCampaign = async () => {
      throw Object.assign(new Error('nothing is running'), { code: 'self-development/task-not-running' })
    }
    const outcome = await stopTask(deps, 'task-1', 'user asked')
    expect(outcome).toMatchObject({
      ok: false,
      reason: 'stop for task task-1 failed',
      error: { code: 'self-development/task-not-running', message: 'nothing is running' },
    })
  })
})
