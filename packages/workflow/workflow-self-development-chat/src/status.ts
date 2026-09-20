/** The `self_development_status` and `self_development_stop` projections over the facade. */

import { join } from 'node:path'
import { acceptancePath } from './acceptance.ts'
import { errorOf } from './errors.ts'
import type {
  CampaignEvent,
  CampaignState,
  StatusReport,
  StopOutcome,
  SelfDevelopmentRemoteFacade,
  TrialPort,
} from './types.ts'

/** Everything one status or stop call needs; every port is test-replaceable. */
export interface StatusDeps {
  /** The stable-side Remote facade (DH-a wire forms). */
  readonly facade: SelfDevelopmentRemoteFacade
  /** The trial service (DH-c); `undefined` when not mounted, so no trial URL is reported. */
  readonly trial: TrialPort | undefined
  /** Resolved deployment configuration. */
  readonly config: { readonly controlDirectory: string }
  /** The most recent campaign event per task id, as recorded from the events service. */
  readonly latestEvents: ReadonlyMap<string, CampaignEvent>
}

/**
 * Build the `self_development_status` report: the task projection summary,
 * the campaign state, the evidence paths, the trial URL when the trial
 * service has an instance for the task, and the most recent campaign event.
 * A facade failure yields `ok: false` with the error code and message.
 * @param deps - the ports and configuration for this call.
 * @param taskId - the task to report on.
 * @returns the status report.
 */
export async function buildStatusReport(deps: StatusDeps, taskId: string): Promise<StatusReport> {
  const paths = {
    acceptancePath: acceptancePath(deps.config.controlDirectory, taskId),
    campaignRecord: join(deps.config.controlDirectory, 'campaigns', `${taskId}.json`),
  }
  try {
    const detail = await deps.facade.getTask(taskId)
    const campaign = await deps.facade.campaign(taskId).catch(() => undefined)
    const trialUrl = await trialUrlFor(deps.trial, taskId)
    const launchProfile = detail.card.launchProfile
    const latestEvent = deps.latestEvents.get(taskId)
    return {
      ok: true,
      task: {
        status: detail.projection.status,
        revision: detail.projection.revision,
        ...(detail.projection.spec === undefined ? {} : { requirement: detail.projection.spec.requirement }),
        consumedRounds: detail.projection.consumedRounds,
        consumedTimeMs: detail.projection.consumedTimeMs,
        planningAuthorized: detail.projection.planningAuthorized,
        noProgressCount: detail.projection.noProgressCount,
      },
      ...(campaign === undefined ? {} : { campaign }),
      paths: {
        ...(launchProfile?.worktree === undefined ? {} : { worktree: launchProfile.worktree }),
        acceptancePath: paths.acceptancePath,
        ...(launchProfile?.dataHome === undefined ? {} : { dataHome: launchProfile.dataHome }),
        campaignRecord: paths.campaignRecord,
      },
      ...(trialUrl === undefined ? {} : { trialUrl }),
      ...(latestEvent === undefined
        ? {}
        : { latestEvent: { kind: latestEvent.kind, title: latestEvent.title, occurredAt: latestEvent.occurredAt } }),
    }
  } catch (error: unknown) {
    return {
      ok: false,
      reason: `status lookup for task ${taskId} failed`,
      paths,
      error: errorOf(error),
    }
  }
}

/**
 * The trial instance URL for one task, when the trial service is mounted and
 * reports a running instance for it.
 * @param trial - the optional trial service.
 * @param taskId - the task whose trial URL is wanted.
 * @returns the URL, or `undefined` when no instance is running.
 */
async function trialUrlFor(trial: TrialPort | undefined, taskId: string): Promise<string | undefined> {
  if (trial === undefined) return undefined
  try {
    const instance = (await trial.trials()).find(entry => entry.taskId === taskId)
    return instance?.url
  } catch {
    // A failing trial service must not fail the status report; the trial URL
    // is presentational and its own health is observable through DH-c.
    return undefined
  }
}

/**
 * Run `self_development_stop`: forward `stopCampaign` with the given reason
 * and project the resulting campaign state. A facade failure yields
 * `ok: false` with the error code and message.
 * @param deps - the ports for this call; only the facade is used.
 * @param taskId - the task whose campaign stops.
 * @param reason - the human-readable stop reason.
 * @returns the stop outcome.
 */
export async function stopTask(deps: StatusDeps, taskId: string, reason: string): Promise<StopOutcome> {
  try {
    const campaign: CampaignState = await deps.facade.stopCampaign(taskId, reason)
    return { ok: true, campaign }
  } catch (error: unknown) {
    return {
      ok: false,
      reason: `stop for task ${taskId} failed`,
      error: errorOf(error),
    }
  }
}
