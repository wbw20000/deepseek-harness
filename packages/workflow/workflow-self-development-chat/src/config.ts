/** Deployment configuration of the chat-side self-development launcher, with resolution and the frozen budget constants. */

import { isAbsolute } from 'node:path'
import type { ProposeBudget } from './types.ts'

/** Upper bound of a time budget in hours, frozen by the 2026-09-20 DH wave decision. */
export const MAX_BUDGET_HOURS = 24

/**
 * The `unlimited` budget expansion, mirroring the DH-a facade's `preset: 'unlimited'`
 * wire expansion: a 24-hour time budget with the campaign's per-phase and
 * no-progress guardrails. The chat side sends the expanded fields alongside the
 * `preset` marker so the call stays valid against the facade before and after
 * the DH-a wire change.
 */
export const UNLIMITED_BUDGET = {
  durationMs: 24 * 3600 * 1000,
  phaseTimeoutMs: 600_000,
  maxStepsPerAttempt: 40,
  noProgressAttemptLimit: 5,
} as const

/**
 * Rebuild the stable version from source after a fast-forward merge:
 * `git merge --ff-only <targetBranch>` in `projectRoot` (a no-op, still
 * exit-0, when `integrate` already fast-forwarded that same worktree),
 * `pnpm install --offline --frozen-lockfile` only when merging changed
 * `pnpm-lock.yaml`, `pnpm run --silent build`, then a detached
 * `restartCommand`, then this process exits.
 */
export interface UpgradeSourceConfig {
  /** Selects the source-tree rebuild-and-restart form. */
  readonly kind: 'source'
  /** Absolute path of the stable version's own worktree (the running deployment, not the task's worktree). */
  readonly projectRoot: string
  /** Argv of the detached restart script, e.g. `['d3/restart-d3.sh']`. */
  readonly restartCommand: readonly string[]
  /** Whether a changed `pnpm-lock.yaml` triggers `pnpm install`; defaults to `true`. `false` never installs. */
  readonly installIfLockfileChanged?: boolean | undefined
}

/** Hand the upgrade off to the packaged launcher; interface and docs only this wave, not field-tested. */
export interface UpgradeLauncherConfig {
  /** Selects the packaged-launcher handoff form. */
  readonly kind: 'launcher'
  /** Absolute path (or resolvable command name) of the `dsh-upgrade`-style launcher binary. */
  readonly dshUpgradeBin: string
}

/** No upgrade/restart step at all — the right choice for a demo repository whose "stable version" is not this deployment. */
export interface UpgradeNoneConfig {
  /** Selects "do nothing after an integrated merge". */
  readonly kind: 'none'
}

/** Post-integration upgrade strategy; see {@link UpgradeSourceConfig}. */
export type UpgradeConfig = UpgradeSourceConfig | UpgradeLauncherConfig | UpgradeNoneConfig

/** cordis.yml configuration of the service. */
export interface SelfDevelopmentChatConfig {
  /** Absolute path of the repository whose stable branch the tasks fork from. */
  readonly stableRepo: string
  /** Absolute control directory; acceptance definitions are written under `<controlDirectory>/acceptance/`. */
  readonly controlDirectory: string
  /** Absolute experiments root used to resolve workspaces when the workspaces service is not mounted. */
  readonly experimentsRoot: string
  /** Actor recorded as creator, plan confirmer, budget approver, and campaign acceptor. */
  readonly actor: string
  /** Branch `self_development_merge` merges a passed task's worktree into. */
  readonly targetBranch: string
  /**
   * Commands run with `sh -c` inside the merged worktree during `verify`, in
   * order; a non-zero exit or a 20-minute timeout fails the merge. Defaults to `[]`.
   */
  readonly integrationGates?: readonly string[] | undefined
  /** How `self_development_merge` rebuilds and restarts the stable version after an `integrated` result; defaults to `{ kind: 'none' }`. */
  readonly upgrade?: UpgradeConfig | undefined
  /** Language of the approval-card copy; defaults to `zh`. */
  readonly cardLocale?: 'zh' | 'en' | undefined
  /** Budget used when the tool call omits one; defaults to the `unlimited` preset. */
  readonly defaultBudget?: ProposeBudget | undefined
  /** Unattended default; defaults to `true`. */
  readonly defaultUnattended?: boolean | undefined
  /**
   * Register the self-development guidance `systemPrompt` section; defaults
   * to `true`. `false` registers nothing, matching a deployment that pastes
   * or composes its own guidance instead.
   */
  readonly guidance?: boolean | undefined
}

/** Validated configuration the service runs under. */
export interface ResolvedChatConfig {
  readonly stableRepo: string
  readonly controlDirectory: string
  readonly experimentsRoot: string
  readonly actor: string
  readonly targetBranch: string
  readonly integrationGates: readonly string[]
  readonly upgrade: UpgradeConfig
  readonly cardLocale: 'zh' | 'en'
  readonly defaultBudget: ProposeBudget
  readonly defaultUnattended: boolean
  readonly guidance: boolean
}

/**
 * Validate the deployment configuration at construction.
 * @param config - configuration as parsed from cordis.yml.
 * @returns the resolved configuration with defaults applied.
 * @throws Error when a path field is empty or relative, the actor or targetBranch
 *   is empty, or the locale is unknown. The default budget and the upgrade
 *   config are validated by the caller through {@link budgetViolation} and
 *   `upgradeViolation` (`upgrade.ts`) to keep this module free of their import cycles.
 */
export function resolveChatConfig(config: SelfDevelopmentChatConfig): ResolvedChatConfig {
  for (const field of ['stableRepo', 'controlDirectory', 'experimentsRoot'] as const) {
    const value = config[field]
    if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value)) {
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- cordis.yml config; type is not a runtime guarantee.
      throw new Error(`self-development chat config is invalid: ${field} must be an absolute path, got ${JSON.stringify(value ?? null)}`)
    }
  }
  if (typeof config.actor !== 'string' || config.actor.length === 0) {
    throw new Error('self-development chat config is invalid: actor must be a non-empty string')
  }
  if (typeof config.targetBranch !== 'string' || config.targetBranch.length === 0) {
    throw new Error('self-development chat config is invalid: targetBranch must be a non-empty string')
  }
  const locale = config.cardLocale ?? 'zh'
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- same defensive reason: not a runtime guarantee.
  if (locale !== 'zh' && locale !== 'en') {
    throw new Error(`self-development chat config is invalid: cardLocale must be "zh" or "en", got ${JSON.stringify(locale)}`)
  }
  return {
    stableRepo: config.stableRepo,
    controlDirectory: config.controlDirectory,
    experimentsRoot: config.experimentsRoot,
    actor: config.actor,
    targetBranch: config.targetBranch,
    integrationGates: config.integrationGates ?? [],
    upgrade: config.upgrade ?? { kind: 'none' },
    cardLocale: locale,
    defaultBudget: config.defaultBudget ?? { preset: 'unlimited' },
    defaultUnattended: config.defaultUnattended ?? true,
    guidance: config.guidance ?? true,
  }
}
