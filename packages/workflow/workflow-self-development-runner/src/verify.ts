/**
 * Verify-only entry point over the independent acceptor. `verifyAcceptance`
 * loads a stable-side acceptance definition and runs its cases against an
 * already-prepared worktree through the existing `loadAcceptance` and
 * `runAcceptance` alone: no headless executor starts, no attempt evidence is
 * written, and no task-control core is touched. It exists for a caller that
 * already has a worktree it wants judged by an acceptance definition and
 * needs nothing else from the supervised-attempt pipeline — for example an
 * integration's pre-fast-forward verification gate.
 * @module @deepseek-ai/dsh-workflow-self-development-runner/verify
 */

import { loadAcceptance, runAcceptance } from './acceptor.ts'
import type { AcceptanceRun } from './acceptor.ts'
import type { RunnerConfig, SandboxConfig } from './types.ts'

/**
 * Placeholder absolute path for a `RunnerConfig` field `verifyAcceptance`
 * itself never reads (`runAcceptance` and `loadAcceptance` touch only
 * `nodeBinary`, `dshHome`, `killGraceMs`, and `experimentsRoot`). Kept
 * path-shaped so the constructed config still satisfies `RunnerConfig`'s
 * documented contract even though nothing here dereferences it.
 */
const UNUSED_RUNNER_CONFIG_PATH = '/verify-acceptance/unused'

/** Deployment inputs {@link verifyAcceptance} needs: a narrow slice of {@link RunnerConfig}. */
export interface VerifyAcceptanceConfig {
  /** Absolute path of the parent directory that holds every experiment worktree; the acceptance definition must resolve outside it. */
  readonly experimentsRoot: string
  /**
   * Milliseconds before `SIGKILL` escalation and the final group-exit
   * confirmation limit; same meaning as {@link RunnerConfig.killGraceMs}.
   */
  readonly killGraceMs: number
  /** Optional wall-clock deadline for the whole run; absent runs with no bound beyond each case's own `timeoutMs`. */
  readonly phaseTimeoutMs?: number
  /**
   * The deployment's sandbox configuration, applied to every case process
   * exactly as a supervised attempt applies it (writable roots: the
   * worktree, the temp roots; unreadable: `denyReadRoots`). Absent means the
   * package default — sandboxing on, no deny-read roots.
   */
  readonly sandbox?: SandboxConfig
}

/** Outcome of {@link verifyAcceptance}. */
export type VerifyAcceptanceResult =
  | { readonly ok: true; readonly report: AcceptanceRun }
  | { readonly ok: false; readonly reason: string }

/**
 * Run a stable-side acceptance definition against a worktree through the
 * existing acceptor alone. `loadAcceptance` validates and parses the
 * definition — rejecting one that resolves inside `config.experimentsRoot`
 * exactly as it always has — and `runAcceptance` executes its cases as
 * detached process groups and evaluates their assertions. The definition's
 * coverage of a frozen test plan is never checked here, unlike a supervised
 * attempt: there is no plan in scope, only the definition's own cases. Every
 * case process inherits `worktree` itself as `DSH_HOME`, since this entry
 * point runs no dsh agent and accepts no separate data-home override.
 * @param worktree - absolute path of the worktree the acceptance cases run against.
 * @param acceptancePath - absolute path of the acceptance definition; must resolve outside `config.experimentsRoot`.
 * @param config - the experiments root, the process-teardown grace period, and an optional overall deadline.
 * @returns `{ ok: true, report }` with the observed per-case run once the acceptor completed — a run whose
 *   cases failed their assertions is still a completed run, reported through `report`, not a
 *   `verifyAcceptance` failure — or `{ ok: false, reason }` when the definition could not be loaded
 *   (including when `acceptancePath` resolves inside `experimentsRoot`) or a case could not be spawned or
 *   its process group confirmed exited. Never throws.
 */
export async function verifyAcceptance(
  worktree: string,
  acceptancePath: string,
  config: VerifyAcceptanceConfig,
): Promise<VerifyAcceptanceResult> {
  try {
    const cases = await loadAcceptance(acceptancePath, config.experimentsRoot)
    const runnerConfig: RunnerConfig = {
      // The node binary this process itself runs under: verifyAcceptance runs
      // no separately configured dsh agent, so there is no other binary to defer to.
      nodeBinary: process.execPath,
      dshBin: UNUSED_RUNNER_CONFIG_PATH,
      dshHome: worktree,
      experimentsRoot: config.experimentsRoot,
      evidenceRoot: UNUSED_RUNNER_CONFIG_PATH,
      killGraceMs: config.killGraceMs,
      ...(config.sandbox === undefined ? {} : { sandbox: config.sandbox }),
    }
    const signal = config.phaseTimeoutMs === undefined ? new AbortController().signal : AbortSignal.timeout(config.phaseTimeoutMs)
    const report = await runAcceptance(runnerConfig, { worktree, cases, signal })
    return { ok: true, report }
  } catch (error) {
    return { ok: false, reason: detail(error) }
  }
}

/**
 * Describe one unknown failure for a boundary message.
 * @param error - thrown value of any type.
 * @returns the value's string form, which carries the message for Error values.
 */
function detail(error: unknown): string {
  return String(error)
}
