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
  readonly cardLocale: 'zh' | 'en'
  readonly defaultBudget: ProposeBudget
  readonly defaultUnattended: boolean
  readonly guidance: boolean
}

/**
 * Validate the deployment configuration at construction.
 * @param config - configuration as parsed from cordis.yml.
 * @returns the resolved configuration with defaults applied.
 * @throws Error when a path field is empty or relative, the actor is empty, or the
 *   locale is unknown. The default budget is validated by the caller through
 *   {@link budgetViolation} to keep this module free of the budget import cycle.
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
    cardLocale: locale,
    defaultBudget: config.defaultBudget ?? { preset: 'unlimited' },
    defaultUnattended: config.defaultUnattended ?? true,
    guidance: config.guidance ?? true,
  }
}
