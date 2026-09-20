/**
 * Opt-in chat-side self-development launcher. The service registers three
 * Agent tools — `self_development_propose`, `self_development_status`, and
 * `self_development_stop` — that draft a task, ask the user exactly one
 * approval, drive the stable-side facade through workspace allocation,
 * acceptance writing, planning, budget, and a campaign start, and project
 * campaign state back into the chat. It registers no durable store of its
 * own: acceptance definitions go under the facade's control directory, and
 * campaign records belong to the facade.
 * @module @deepseek-ai/dsh-workflow-self-development-chat
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-workflow-self-development-events'
import { ASSERTION_SHAPE_REFERENCE, controlDirectoryPlacementViolation } from './acceptance.ts'
import { DEFAULT_COMMIT_IDENTITY, resolveChatConfig } from './config.ts'
import type { CommitIdentity, ResolvedChatConfig, SelfDevelopmentChatConfig, UpgradeConfig } from './config.ts'
import { budgetViolation } from './budget.ts'
import { GUIDANCE_SECTION_NAME, GUIDANCE_SECTION_ORDER_NAME, GUIDANCE_TEXT } from './guidance.ts'
import { runMerge } from './merge.ts'
import type { MergeDeps } from './merge.ts'
import { deliverCampaignNotice } from './notify.ts'
import type { NotifiableAgent } from './notify.ts'
import { runPropose } from './propose.ts'
import type { ProposeDeps } from './propose.ts'
import { buildStatusReport, stopTask } from './status.ts'
import type { StatusDeps } from './status.ts'
import { upgradeViolation } from './upgrade.ts'
import type {
  ApprovalPort,
  CampaignEvent,
  CampaignEventSource,
  MergeBlockedEventPayload,
  MergeInput,
  MergeIntegratedEventPayload,
  MergeOutcome,
  ProposeBudget,
  ProposeInput,
  ProposeOutcome,
  RunnerVerifyPort,
  SelfDevelopmentRemoteFacade,
  StatusReport,
  StopOutcome,
  SystemPromptPort,
  TrialPort,
  WorkspacesPort,
} from './types.ts'

/** Service ports, replaceable wholesale by direct unit tests. */
export interface ChatPorts {
  /** The stable-side facade; required — the tools are useless without it. */
  readonly facade: SelfDevelopmentRemoteFacade
  /** The approval service; required — the proposal fails closed without it. */
  readonly approval: ApprovalPort | undefined
  /** The optional workspaces service; without one, `<experimentsRoot>/<taskId>` must pre-exist. */
  readonly workspaces: WorkspacesPort | undefined
  /** The optional events service, subscribed for campaign result events. */
  readonly events: CampaignEventSource | undefined
  /** The optional trial service (DH-c), read for the status tool's trial URL. */
  readonly trial: TrialPort | undefined
  /** The optional `systemPrompt` service; without one, the guidance section is skipped (logged at debug). */
  readonly systemPrompt: SystemPromptPort | undefined
  /** The optional runner verification port (DI-a); without one, `self_development_merge` fails closed rather than merging unverified. */
  readonly runner: RunnerVerifyPort | undefined
}

/** Read the service ports from the mounted services. */
function contextPorts(ctx: Context): ChatPorts {
  return {
    // `static inject` guarantees the facade in composition; direct construction
    // passes ports explicitly, so the read may stay structural.
    facade: ctx.get('selfDevelopmentRemote') as SelfDevelopmentRemoteFacade,
    approval: ctx.get('approval'),
    workspaces: ctx.get('selfDevelopmentWorkspaces') as WorkspacesPort | undefined,
    // No cast needed here (unlike workspaces/trial/runner): importing the
    // events package's own types below now loads its real `declare module`
    // augmentation, so `ctx.get('selfDevelopmentEvents')` is already typed.
    events: ctx.get('selfDevelopmentEvents'),
    trial: ctx.get('selfDevelopmentTrial') as TrialPort | undefined,
    systemPrompt: ctx.get('systemPrompt'),
    runner: ctx.get('selfDevelopmentRunner') as RunnerVerifyPort | undefined,
  }
}

/**
 * Chat-side self-development launcher. Composition declares the hard
 * dependencies through {@linkcode SelfDevelopmentChat.inject}; the optional
 * workspaces, events, trial, and `systemPrompt` services are read with
 * `ctx.get` and every tool degrades gracefully without them. When
 * `systemPrompt` is mounted and `guidance` is not disabled, the service
 * contributes a fixed section (see `guidance.ts`) so the model is actually
 * told to call `self_development_propose` instead of editing the trial
 * branch's workspace itself — a chat-side field test found that a
 * README-only, never-injected snippet was not enough on its own.
 */
export class SelfDevelopmentChat extends Service {
  static inject = ['tools', 'selfDevelopmentRemote', 'approval']

  /** Runtime schema for the service config; defaults live in config resolution. */
  static Config = z.object({
    stableRepo: z.string(),
    controlDirectory: z.string(),
    experimentsRoot: z.string(),
    actor: z.string(),
    targetBranch: z.string(),
    integrationGates: z.array(z.string()).default([]),
    upgrade: z.any<UpgradeConfig>().default({ kind: 'none' }),
    commitIdentity: z.any<CommitIdentity>().default(DEFAULT_COMMIT_IDENTITY),
    cardLocale: z.union(['zh', 'en'] as const).default('zh'),
    defaultUnattended: z.boolean().default(true),
    defaultBudget: z.any<ProposeBudget>().default({ preset: 'unlimited' }),
    guidance: z.boolean().default(true),
  }) as unknown as z<SelfDevelopmentChatConfig>

  /** Validated deployment configuration the service runs under. */
  private readonly resolved: ResolvedChatConfig

  /** The stable-side facade every tool forwards to. */
  private readonly facade: SelfDevelopmentRemoteFacade

  /** The optional workspaces service allocation port. */
  private readonly workspaces: WorkspacesPort | undefined

  /** The optional trial service port, read by the status tool. */
  private readonly trial: TrialPort | undefined

  /** The optional runner verification port; `undefined` fails `self_development_merge` closed. */
  private readonly runner: RunnerVerifyPort | undefined

  /** The approval service; `undefined` only in direct construction, where the proposal fails closed. */
  private readonly approval: ApprovalPort | undefined

  /** Task ids this service started; the `parallel: false` check runs against these. */
  private readonly startedTaskIds: string[] = []

  /** The most recent campaign event per task id, folded in from the events service. */
  private readonly latestEvents = new Map<string, CampaignEvent>()

  /**
   * The agent that proposed each still-pending task, kept only long enough to
   * deliver a best-effort chat notice when its campaign settles (see
   * `notify.ts`). Entries are consumed on delivery; a task whose campaign
   * settles without a live entry here (process restarted, agent disposed) is
   * silently skipped — `self_development_status` remains the reliable path.
   */
  private readonly agentsByTask = new Map<string, NotifiableAgent>()

  /** Disposers of every registry contribution, collected for the fiber effect. */
  private readonly disposers: (() => void)[] = []

  /**
   * @param ctx - owning Cordis context.
   * @param config - deployment configuration for the stable repo, control
   *   directory, experiments root, actor, target branch, integration gates,
   *   upgrade strategy, card language, and defaults.
   * @param ports - service ports; defaults to the context's mounted services.
   * @throws Error when the configuration is invalid or the default budget is
   *   not a valid budget. Misconfiguration fails at load.
   */
  constructor(ctx: Context, config: SelfDevelopmentChatConfig, ports: ChatPorts = contextPorts(ctx)) {
    super(ctx, 'selfDevelopmentChat')
    if (config.defaultBudget !== undefined && budgetViolation(config.defaultBudget) !== undefined) {
      // Reached only when defaultBudget is explicitly set and invalid: an
      // absent defaultBudget defaults to the always-valid unlimited preset,
      // so this branch never needs a fallback for the JSON.stringify input.
      throw new Error(`self-development chat config is invalid: defaultBudget ${JSON.stringify(config.defaultBudget)} is not a valid budget`)
    }
    const placement = controlDirectoryPlacementViolation(config.controlDirectory, config.experimentsRoot)
    if (placement !== undefined) {
      // Fail to mount rather than starting and burning campaign rounds: a
      // field test found this misconfiguration only after 20,000 rounds all
      // failed closed at the runner (see `controlDirectoryPlacementViolation`).
      throw new Error(`self-development chat config is invalid: ${placement}`)
    }
    if (config.upgrade !== undefined) {
      const upgrade = upgradeViolation(config.upgrade)
      if (upgrade !== undefined) {
        throw new Error(`self-development chat config is invalid: ${upgrade}`)
      }
    }
    this.resolved = resolveChatConfig(config)
    this.facade = ports.facade
    this.workspaces = ports.workspaces
    this.trial = ports.trial
    this.runner = ports.runner
    this.approval = ports.approval

    if (this.resolved.guidance) {
      if (ports.systemPrompt === undefined) {
        ctx.logger.debug('self-development-chat: ctx.systemPrompt is not mounted; the self-development guidance section is not registered.')
      } else {
        this.disposers.push(ports.systemPrompt.section({
          name: GUIDANCE_SECTION_NAME,
          order: ports.systemPrompt.getSectionOrder(GUIDANCE_SECTION_ORDER_NAME),
          text: GUIDANCE_TEXT,
        }))
      }
    }

    this.disposers.push(ctx.tools.register(defineTool({
      name: 'self_development_propose',
      description: 'Propose one self-development task for the trial branch: draft the requirement, acceptance cases, and budget, ask the user exactly once for approval, and on approval automatically allocate the workspace, write the acceptance definition, create the task, authorize planning, submit and confirm the plan, approve the budget, and start the unattended campaign. The result reports every completed step; on failure it reports the steps done so far and the reason.',
      parameters: {
        requirement: { type: 'string', required: true, description: 'The requirement, consolidated from the user\'s words.' },
        allowedModificationScope: {
          type: 'array',
          required: true,
          items: { type: 'string' },
          description: 'Repository paths (globs allowed) the development worker may modify.',
        },
        plan: {
          type: 'object',
          required: true,
          additionalProperties: false,
          properties: {
            requiredCases: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  caseId: { type: 'string', required: true, description: 'The acceptance case id, defined by the acceptance definition.' },
                  requirement: { type: 'string', required: true, description: 'What the case verifies, in one sentence.' },
                  assertionIds: { type: 'array', required: true, items: { type: 'string' }, description: 'Assertion ids from the acceptance case this plan item covers.' },
                },
              },
              description: 'The acceptance cases every campaign round must pass.',
            },
            manualCases: { type: 'array', required: true, items: { type: 'string' }, description: 'Acceptance items reserved for human verification.' },
          },
        },
        acceptance: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              description: 'The acceptance definition you drafted. Every plan.requiredCases[].caseId must appear as a cases[].caseId here, and every assertionIds entry it names must appear as an assertions[].assertionId in that case.',
              properties: {
                cases: {
                  type: 'array',
                  required: true,
                  description: 'One or more acceptance cases.',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      caseId: { type: 'string', required: true, description: 'Matches a plan.requiredCases[].caseId.' },
                      command: { type: 'array', required: true, items: { type: 'string' }, description: 'Argv to run, e.g. ["node", "cli.mjs", "--json"].' },
                      cwd: { type: 'string', description: 'Working directory for the command; defaults to the worktree root.' },
                      timeoutMs: { type: 'integer', required: true, description: 'Positive timeout in milliseconds.' },
                      assertions: {
                        type: 'array',
                        required: true,
                        description: ASSERTION_SHAPE_REFERENCE,
                        items: {
                          oneOf: [
                            {
                              type: 'object',
                              additionalProperties: false,
                              properties: {
                                assertionId: { type: 'string', required: true, description: 'Matches a plan.requiredCases[].assertionIds entry.' },
                                kind: { type: 'string', required: true, const: 'exit-code' },
                                expected: { type: 'integer', required: true, description: 'Expected process exit code.' },
                              },
                            },
                            {
                              type: 'object',
                              additionalProperties: false,
                              properties: {
                                assertionId: { type: 'string', required: true, description: 'Matches a plan.requiredCases[].assertionIds entry.' },
                                kind: { type: 'string', required: true, const: 'stdout-includes' },
                                text: { type: 'string', required: true, description: 'Substring stdout must contain.' },
                              },
                            },
                            {
                              type: 'object',
                              additionalProperties: false,
                              properties: {
                                assertionId: { type: 'string', required: true, description: 'Matches a plan.requiredCases[].assertionIds entry.' },
                                kind: { type: 'string', required: true, const: 'file-exists' },
                                path: { type: 'string', required: true, description: 'Worktree-relative path that must exist.' },
                              },
                            },
                            {
                              type: 'object',
                              additionalProperties: false,
                              properties: {
                                assertionId: { type: 'string', required: true, description: 'Matches a plan.requiredCases[].assertionIds entry.' },
                                kind: { type: 'string', required: true, const: 'file-includes' },
                                path: { type: 'string', required: true, description: 'Worktree-relative path to read.' },
                                text: { type: 'string', required: true, description: 'Substring the file must contain.' },
                              },
                            },
                          ],
                        },
                      },
                    },
                  },
                },
              },
            },
            {
              type: 'string',
              description: 'Only when your tool call cannot emit a nested object for this parameter: the identical shape as a JSON-encoded string.',
            },
          ],
          required: true,
          description: 'The acceptance definition you drafted, matching the object shape above (or that same JSON as a string).',
        },
        budget: {
          oneOf: [
            { type: 'object', additionalProperties: false, properties: { preset: { type: 'string', required: true, const: 'unlimited', description: 'No round limit, time capped at 24 hours.' } } },
            { type: 'object', additionalProperties: false, properties: { mode: { type: 'string', required: true, const: 'rounds' }, maxRounds: { type: 'integer', required: true, description: 'Maximum campaign rounds, positive.' } } },
            { type: 'object', additionalProperties: false, properties: { mode: { type: 'string', required: true, const: 'time' }, hours: { type: 'number', required: true, description: 'Time budget in hours; at most 24.' } } },
          ],
          description: 'The campaign budget: { preset: "unlimited" }, { mode: "rounds", maxRounds }, or { mode: "time", hours ≤ 24 }. Ask the user which one when unsure.',
        },
        unattended: { type: 'boolean', description: 'One approval covers every campaign round. Defaults to the deployment default (true).' },
        parallel: { type: 'boolean', description: 'Whether the proposal may start while another campaign is running. Defaults to true; with false, a running campaign refuses the proposal.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: proposeResultLine(value) }],
      },
      execute: async (args, exec) => {
        // Deployment defaults (budget, unattended, parallel) are applied
        // inside `runPropose` itself (see `resolveProposeInput`), so a direct
        // unit-tested call gets the same defaulting a live tool call does.
        return await this.propose(args, exec) as unknown as JsonValue
      },
    })))

    this.disposers.push(ctx.tools.register(defineTool({
      name: 'self_development_status',
      description: 'Report one self-development task: control-state summary, campaign state (rounds, last outcome, reason), evidence paths, the trial instance URL when one is running, and the most recent campaign event.',
      parameters: {
        taskId: { type: 'string', required: true, description: 'The task id returned by self_development_propose.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: statusResultLine(value) }],
      },
      execute: async args => await this.status(args.taskId) as unknown as JsonValue,
    })))

    this.disposers.push(ctx.tools.register(defineTool({
      name: 'self_development_stop',
      description: 'Stop one running self-development campaign: the current attempt is cancelled and the campaign loop ends. Pass the reason the user gave.',
      parameters: {
        taskId: { type: 'string', required: true, description: 'The task id returned by self_development_propose.' },
        reason: { type: 'string', required: true, description: 'The human-readable stop reason.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: stopResultLine(value) }],
      },
      execute: async args => await this.stop(args.taskId, args.reason) as unknown as JsonValue,
    })))

    this.disposers.push(ctx.tools.register(defineTool({
      name: 'self_development_merge',
      description: 'Merge one passed, awaiting-trial self-development task into the stable branch. Host-only: only run this when the current process is the stable deployment being upgraded, since a successful merge rebuilds and restarts it. Asks the user exactly once for approval — the card also names the automatic repair campaign a conflict or verification failure triggers, so that case never asks a second time. On approval: records trial approval, integrates the task worktree (rebasing onto a moved target branch when needed), independently re-verifies acceptance and every configured integration gate before fast-forwarding, and on success runs the deployment\'s configured upgrade. A conflict or post-rebase verification failure instead starts an unattended repair campaign for the same acceptance definition. Nothing already completed is rolled back on any other failure.',
      parameters: {
        taskId: { type: 'string', description: 'The task to merge; omit to take the most recently proposed task that is awaiting-trial.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: mergeResultLine(value) }],
      },
      execute: async (args, exec) => {
        return await this.merge(args, exec) as unknown as JsonValue
      },
    })))

    if (ports.events !== undefined) {
      const unsubscribe = ports.events.subscribe((event) => {
        if (event.kind !== 'campaign-passed' && event.kind !== 'campaign-ended') return
        this.latestEvents.set(event.taskId, event)
        deliverCampaignNotice(this.agentsByTask, event, this.resolved.cardLocale)
      })
      this.disposers.push(unsubscribe)
    }

    ctx.effect(() => () => {
      for (const dispose of this.disposers) dispose()
      this.disposers.length = 0
      this.agentsByTask.clear()
    }, 'self-development-chat: unregister tools and campaign-event subscription')
  }

  /**
   * Run one proposal end to end and remember the task on success. Private:
   * this backs the `self_development_propose` tool's `execute`, not a
   * standalone service API — keeping it off the public surface also keeps it
   * out of the Cordis service-method catalog, which would otherwise demand a
   * documentation-page classification for every domain type it mentions.
   * @param input - the validated tool input.
   * @param exec - the tool execution context the approval card attaches to.
   * @returns the proposal outcome.
   */
  private async propose(input: ProposeInput, exec?: Pick<ToolRunContext, 'agent' | 'callId' | 'signal'>): Promise<ProposeOutcome> {
    const deps: ProposeDeps = {
      facade: this.facade,
      approval: this.approval,
      workspaces: this.workspaces,
      config: this.resolved,
      ...(exec?.agent === undefined ? {} : { agent: exec.agent }),
      ...(exec?.callId === undefined ? {} : { callId: exec.callId }),
      ...(exec?.signal === undefined ? {} : { signal: exec.signal }),
      knownTaskIds: [...this.startedTaskIds],
    }
    const outcome = await runPropose(deps, input)
    if (outcome.ok) {
      this.startedTaskIds.push(outcome.taskId)
      if (exec?.agent !== undefined) this.agentsByTask.set(outcome.taskId, exec.agent)
    }
    return outcome
  }

  /**
   * Run one merge end to end and remember every task it started — the merged
   * task itself (for a later `parallel: false` check, mirroring `propose`)
   * and, on `conflict`/`verification-failed`, the repair campaign's own task
   * id, registering the calling agent for its eventual settlement notice the
   * same way a direct `self_development_propose` call would. Private for the
   * same reason as {@link propose}.
   * @param input - the validated tool input.
   * @param exec - the tool execution context the approval card attaches to.
   * @returns the merge outcome.
   */
  private async merge(input: MergeInput, exec?: Pick<ToolRunContext, 'agent' | 'callId' | 'signal'>): Promise<MergeOutcome> {
    const deps: MergeDeps = {
      facade: this.facade,
      approval: this.approval,
      workspaces: this.workspaces,
      runner: this.runner,
      config: this.resolved,
      ...(exec?.agent === undefined ? {} : { agent: exec.agent }),
      ...(exec?.callId === undefined ? {} : { callId: exec.callId }),
      ...(exec?.signal === undefined ? {} : { signal: exec.signal }),
      knownTaskIds: [...this.startedTaskIds],
      emitIntegrated: (payload: MergeIntegratedEventPayload) => {
        this.ctx.emit('self-development-chat/merge-integrated', payload)
        // The name and shape @deepseek-ai/dsh-workflow-self-development-events
        // actually subscribes to (packages/workflow/workflow-self-development-events/src/merge.ts:50-59).
        this.ctx.emit('self-development/merge-integrated', { taskId: payload.taskId, revision: payload.revision })
      },
      emitBlocked: (payload: MergeBlockedEventPayload) => {
        this.ctx.emit('self-development-chat/merge-blocked', payload)
        this.ctx.emit('self-development/merge-blocked', { taskId: payload.taskId, status: payload.status, revision: payload.revision })
      },
    }
    const outcome = await runMerge(deps, input)
    if (outcome.ok) {
      this.startedTaskIds.push(outcome.taskId)
      if (outcome.repair?.ok === true) {
        this.startedTaskIds.push(outcome.repair.taskId)
        if (exec?.agent !== undefined) this.agentsByTask.set(outcome.repair.taskId, exec.agent)
      }
    }
    return outcome
  }

  /**
   * Build the `self_development_status` report for one task. Private for the
   * same reason as {@link propose}.
   * @param taskId - the task to report on.
   * @returns the status report.
   */
  private status(taskId: string): Promise<StatusReport> {
    return buildStatusReport(this.statusDeps(), taskId)
  }

  /**
   * Stop one task's campaign with the given reason. Private for the same
   * reason as {@link propose}.
   * @param taskId - the task whose campaign stops.
   * @param reason - the human-readable stop reason.
   * @returns the stop outcome.
   */
  private stop(taskId: string, reason: string): Promise<StopOutcome> {
    return stopTask(this.statusDeps(), taskId, reason)
  }

  /** The status/stop dependency view over this service's ports and config. */
  private statusDeps(): StatusDeps {
    return {
      facade: this.facade,
      trial: this.trial,
      config: { controlDirectory: this.resolved.controlDirectory },
      latestEvents: this.latestEvents,
    }
  }
}

/** One-line model/UI summary of a proposal outcome. */
function proposeResultLine(value: JsonValue): string {
  const outcome = value as unknown as ProposeOutcome
  if (outcome.ok) {
    return `Task ${outcome.taskId}: campaign started (${outcome.campaign.status}); worktree ${outcome.workspace}`
  }
  return `Task ${outcome.taskId ?? '(not created)'}: proposal failed — ${outcome.reason}`
}

/** One-line model/UI summary of a status report. */
function statusResultLine(value: JsonValue): string {
  const report = value as unknown as StatusReport
  if (!report.ok) return `Status failed — ${report.error?.message ?? report.reason}`
  const campaign = report.campaign
  const campaignText = campaign === undefined
    ? 'no campaign'
    : `${campaign.status}, round ${campaign.rounds}${campaign.lastOutcome === undefined ? '' : `, last ${campaign.lastOutcome}`}`
  const trialText = report.trialUrl === undefined ? '' : `; trial ${report.trialUrl}`
  return `Task status: ${report.task?.status}, campaign ${campaignText}${trialText}`
}

/** One-line model/UI summary of a stop outcome. */
function stopResultLine(value: JsonValue): string {
  const outcome = value as unknown as StopOutcome
  return outcome.ok
    ? `Campaign stopped: ${outcome.campaign?.status}`
    : `Stop failed — ${outcome.error?.message ?? outcome.reason}`
}

/** One-line model/UI summary of a merge outcome. */
function mergeResultLine(value: JsonValue): string {
  const outcome = value as unknown as MergeOutcome
  if (!outcome.ok) return `Task ${outcome.taskId ?? '(unknown)'}: merge failed — ${outcome.reason}`
  const result = outcome.result
  if (result.status === 'integrated') {
    const upgradeText = outcome.upgrade === undefined ? '' : `; ${outcome.upgrade.detail}`
    const snapshotText = result.snapshotCommit === undefined ? '' : ` (uncommitted worktree changes were snapshotted as ${result.snapshotCommit})`
    return `Task ${outcome.taskId}: merged ${result.commit} into stable, rebuilding and restarting${snapshotText}${upgradeText}`
  }
  if (result.status === 'conflict' || result.status === 'verification-failed') {
    const repairText = outcome.repair?.ok === true
      ? `repair campaign ${outcome.repair.taskId} started, unattended`
      : `repair campaign failed to start${outcome.repair === undefined ? '' : `: ${outcome.repair.reason}`}`
    return `Task ${outcome.taskId}: merge blocked (${result.status}); ${repairText}`
  }
  return `Task ${outcome.taskId}: merge failed — ${result.reason}`
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    selfDevelopmentChat: SelfDevelopmentChat
  }
  interface Events {
    /**
     * Emitted after a successful `self_development_merge` fast-forward; see
     * {@link MergeIntegratedEventPayload}.
     * @param payload - the task id, the fast-forwarded commit, whether the target moved, the revision, and the time.
     * @mode emit
     */
    'self-development-chat/merge-integrated'(payload: MergeIntegratedEventPayload): void
    /**
     * Emitted when `self_development_merge` settles on `conflict`,
     * `verification-failed`, or `failed`; see {@link MergeBlockedEventPayload}.
     * @param payload - the task id, the block status, the conflicting files or reason, the revision, and the time.
     * @mode emit
     */
    'self-development-chat/merge-blocked'(payload: MergeBlockedEventPayload): void
  }
}

export default SelfDevelopmentChat
