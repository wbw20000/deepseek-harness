/**
 * macOS file-level sandbox (Tier 1): every headless-executor and
 * acceptance-case spawn is wrapped in `sandbox-exec -p <SBPL profile>`
 * (Seatbelt) so the spawned process can write only the experiment worktree,
 * the attempt's data directory, the temporary-directory spellings, and any
 * deployment-configured extra roots, and can read nothing under a
 * deployment-configured deny-read root. This module is self-contained: it
 * does not depend on `@deepseek-ai/dsh-sandbox-local`, so the host's own
 * sandbox-provider policy objects never leak into the experiment/acceptance
 * spawn path.
 *
 * A profile root only fences what it names once resolved through the
 * filesystem: `sandbox-exec`'s subpath matching is judged against the
 * *resolved* path the kernel actually touches, so a profile literal that
 * still carries a symlinked ancestor (`/tmp` before it resolves to
 * `/private/tmp`, or a deployment's `~/.dsh` before it resolves to wherever
 * it actually points) matches neither spelling and silently fails to grant
 * or deny anything. Every root this module emits is therefore resolved with
 * {@link resolveSandboxRoot} before it reaches {@link buildSeatbeltProfile}.
 *
 * This is Tier 1, not full isolation: the sandboxed process keeps the
 * network (the experiment Agent must reach the configured model provider),
 * keeps visibility of other processes and the filesystem's read surface
 * outside `denyReadRoots`, and runs under `sandbox-exec`, a mechanism Apple
 * marks deprecated but still ships and enforces on every current macOS. It
 * is also darwin-only: on every other platform this package carries no
 * sandbox tier, so a spawn runs unwrapped and {@link assertSandboxAvailable}
 * never refuses a launch there — "no macOS mechanism" is the platform's
 * normal state, not a broken environment.
 * @module @deepseek-ai/dsh-workflow-self-development-runner/sandbox
 */

import { spawn } from 'node:child_process'
import type { ChildProcessByStdio, SpawnOptionsWithStdioTuple } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { Readable } from 'node:stream'
import { SelfDevelopmentRunnerError } from './runtime.ts'
import type { SandboxConfig } from './types.ts'

/** `RunnerConfig.sandbox` when a deployment configures none: sandboxing on, no extra roots. */
export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  enabled: true,
  denyReadRoots: [],
  extraWritableRoots: [],
  sandboxExec: '/usr/bin/sandbox-exec',
}

/** Quote one already-resolved path as an SBPL string literal (same escaping as `sandbox-local`'s `sbplString`). */
function sbplString(path: string): string {
  return `"${path.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`)}"`
}

/** Drop exact-string duplicates while keeping first-seen order; a redundant subpath rule is harmless but not worth emitting twice. */
function dedupe(items: readonly string[]): string[] {
  return [...new Set(items)]
}

/** Already-resolved roots a Seatbelt profile grants or denies. */
export interface SeatbeltProfileInput {
  /** Absolute, filesystem-resolved directories the wrapped process may write under, plus `/dev/null`. */
  readonly writableRoots: readonly string[]
  /** Absolute, filesystem-resolved directories the wrapped process may not read under. */
  readonly denyReadRoots: readonly string[]
}

/**
 * Build the SBPL profile text for one confined spawn: default-allow (so the
 * wrapped process keeps reads, process-exec, and network — this is a
 * file-write fence, not full isolation), a global write deny, `/dev/null`
 * re-allowed for write, every writable root re-allowed for write, and
 * finally one `file-read*` deny per deny-read root. The deny-read forms are
 * written last on purpose: Seatbelt/SBPL judges each operation by the LAST
 * rule in the profile that matches it, so a deny appended after the leading
 * `(allow default)` overrides it for reads under that root, while the
 * write-only rules above it are untouched (`file-write*` and `file-read*`
 * are disjoint operation classes).
 * @param input - the writable and deny-read roots, already resolved through the filesystem.
 * @returns the profile text, ready for `sandbox-exec -p`.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_CONFIG_INVALID` when any root is not an
 *   absolute path: a relative literal would not name the directory the caller intended, silently
 *   fencing the wrong path or nothing at all.
 */
export function buildSeatbeltProfile(input: SeatbeltProfileInput): string {
  for (const root of [...input.writableRoots, ...input.denyReadRoots]) {
    if (!isAbsolute(root)) {
      throw new SelfDevelopmentRunnerError(
        `sandbox profile root ${JSON.stringify(root)} must be an absolute path`,
        'SELF_DEV_RUNNER_CONFIG_INVALID',
      )
    }
  }
  const writableRoots = dedupe(input.writableRoots)
  const denyReadRoots = dedupe(input.denyReadRoots)
  const forms = ['(version 1)', '(allow default)', '(deny file-write*)', `(allow file-write* (literal ${sbplString('/dev/null')}))`]
  if (writableRoots.length > 0) {
    forms.push(`(allow file-write* ${writableRoots.map(root => `(subpath ${sbplString(root)})`).join(' ')})`)
  }
  for (const root of denyReadRoots) {
    forms.push(`(deny file-read* (subpath ${sbplString(root)}))`)
  }
  return forms.join(' ')
}

/**
 * Wrap one command's argv in the sandbox invocation. The return type keeps
 * the leading `[sandboxExec, '-p', profile]` prefix as fixed tuple
 * positions (not a plain `string[]`), so a caller splitting it into
 * `child_process.spawn`'s `(command, args)` shape reads `wrapped[0]` as a
 * definite `string` under `noUncheckedIndexedAccess` instead of needing an
 * unchecked assertion.
 * @param sandboxExec - absolute path of the `sandbox-exec` executable.
 * @param profile - SBPL profile text from {@link buildSeatbeltProfile}.
 * @param argv - the program and its arguments, unwrapped.
 * @returns `[sandboxExec, '-p', profile, ...argv]`.
 */
export function wrapCommand(sandboxExec: string, profile: string, argv: readonly string[]): [string, '-p', string, ...string[]] {
  return [sandboxExec, '-p', profile, ...argv]
}

/** Whether an error from `fs.realpath` names a path component that simply does not exist yet. */
function isMissingPathError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false
  const code = (error as { code?: unknown }).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * Resolve one sandbox root through the filesystem. A path that already
 * exists resolves outright to its realpath. A path that does not exist yet —
 * a fresh attempt's not-yet-created data directory is the common case —
 * resolves its deepest existing ancestor and rejoins the remaining
 * components literally: nothing exists at those components yet, so none of
 * them can be a symlink, and the ancestor's own resolution still defeats a
 * symlink earlier in the path (a deployment's `dshHome` living under a
 * symlinked parent). This mirrors `staysInside`'s walk in
 * `path-containment.ts` for the same reason: a Seatbelt subpath rule must
 * carry the real spelling, so it is built the same way whether the target
 * exists yet or not.
 * @param path - absolute candidate root.
 * @returns the best-known real spelling of `path`.
 * @throws whatever `fs.realpath` rejects with, for any failure other than a missing path component.
 */
export async function resolveSandboxRoot(path: string): Promise<string> {
  let probe = path
  const missingTail: string[] = []
  for (;;) {
    try {
      const resolved = await realpath(probe)
      return missingTail.length === 0 ? resolved : join(resolved, ...[...missingTail].reverse())
    } catch (error) {
      if (!isMissingPathError(error)) throw error
      const parent = dirname(probe)
      /* v8 ignore next -- '/' always resolves, so the walk never reaches a parent equal to itself. */
      if (parent === probe) return path
      missingTail.push(basename(probe))
      probe = parent
    }
  }
}

/** Availability verdict of one Seatbelt probe. */
export type SandboxAvailability = 'available' | 'unavailable'

/** The most permissive profile a Seatbelt probe can apply: it asks only whether the kernel accepts a profile at all. */
const PROBE_PROFILE = '(version 1)(allow default)'

/**
 * Functional Seatbelt probe: apply {@link PROBE_PROFILE} through
 * `sandbox-exec -p` and run `/usr/bin/true` under it. Exit 0 means the
 * kernel accepted the profile — `sandbox_init` refuses a profile it cannot
 * compile and `sandbox-exec` then exits non-zero without ever running the
 * command, and a missing or non-executable `sandboxExec` reports the same
 * `unavailable` verdict through the child's `error` event.
 * @param sandboxExec - absolute path of the `sandbox-exec` executable to probe.
 * @param platform - host platform; overridable so tests can exercise the non-darwin branch without touching the process global.
 * @returns `'available'` once the probe process exits 0, `'unavailable'` on any other exit, spawn failure, or non-darwin platform.
 */
export async function probeSandbox(sandboxExec: string, platform: NodeJS.Platform = process.platform): Promise<SandboxAvailability> {
  if (platform !== 'darwin') return 'unavailable'
  return new Promise((resolveProbe) => {
    const child = spawn(sandboxExec, ['-p', PROBE_PROFILE, '/usr/bin/true'], { stdio: 'ignore' })
    child.on('error', () => { resolveProbe('unavailable') })
    child.on('close', (code) => { resolveProbe(code === 0 ? 'available' : 'unavailable') })
  })
}

/**
 * Gate a sandboxed spawn on the mechanism actually working. A deployment
 * that configured `enabled: false` is never probed — an explicit opt-out
 * into no isolation is not a broken environment. On every platform but
 * `darwin` this package carries no sandbox tier at all, so the gate is a
 * silent no-op there too — the same as `enabled: false` — rather than a
 * refusal: "no macOS mechanism available" is that platform's expected state,
 * not a failure worth blocking a launch over. Only on `darwin` with
 * sandboxing enabled does a failed probe refuse the caller instead of
 * letting the spawn run unconfined.
 * @param sandbox - the deployment's sandbox configuration.
 * @param platform - host platform; overridable so tests can exercise every branch without touching the process global.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_SANDBOX_UNAVAILABLE` when sandboxing is
 *   enabled, the host is `darwin`, and the probe does not report `available`.
 */
export async function assertSandboxAvailable(sandbox: SandboxConfig, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (!sandbox.enabled || platform !== 'darwin') return
  const availability = await probeSandbox(sandbox.sandboxExec, platform)
  if (availability === 'unavailable') {
    throw new SelfDevelopmentRunnerError(
      `sandbox-exec at ${JSON.stringify(sandbox.sandboxExec)} is unavailable or refused a minimal profile; `
        + 'set sandbox.enabled: false to run this deployment without file-level isolation (no isolation at all — see the README)',
      'SELF_DEV_RUNNER_SANDBOX_UNAVAILABLE',
    )
  }
}

/**
 * Whether a spawn should actually be wrapped: the deployment enabled
 * sandboxing and the host is `darwin`. Callers branch their spawn on this
 * instead of `sandbox.enabled` alone, so a non-darwin host runs unwrapped
 * without needing an explicit `enabled: false` override.
 * @param sandbox - the deployment's sandbox configuration.
 * @param platform - host platform; overridable so tests can exercise every branch without touching the process global.
 * @returns true only when the deployment enabled sandboxing and the host is `darwin`.
 */
export function sandboxEffectivelyEnabled(sandbox: SandboxConfig, platform: NodeJS.Platform = process.platform): boolean {
  return sandbox.enabled && platform === 'darwin'
}

/**
 * Reject a non-absolute entry in the deployment's sandbox configuration at
 * construction time, before any attempt runs.
 * @param sandbox - the deployment's sandbox configuration.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_CONFIG_INVALID` when `sandboxExec` is
 *   empty or relative, or any `denyReadRoots`/`extraWritableRoots` entry is relative.
 */
export function assertSandboxRootsAbsolute(sandbox: SandboxConfig): void {
  if (sandbox.sandboxExec.length === 0 || !isAbsolute(sandbox.sandboxExec)) {
    throw new SelfDevelopmentRunnerError(
      `sandbox.sandboxExec ${JSON.stringify(sandbox.sandboxExec)} must be an absolute path`,
      'SELF_DEV_RUNNER_CONFIG_INVALID',
    )
  }
  const fields = [['denyReadRoots', sandbox.denyReadRoots], ['extraWritableRoots', sandbox.extraWritableRoots]] as const
  for (const [field, roots] of fields) {
    for (const root of roots) {
      if (!isAbsolute(root)) {
        throw new SelfDevelopmentRunnerError(
          `sandbox.${field} entry ${JSON.stringify(root)} must be an absolute path`,
          'SELF_DEV_RUNNER_CONFIG_INVALID',
        )
      }
    }
  }
}

/**
 * Whether captured stderr carries `sandbox-exec`'s own launch-failure
 * signature. `sandbox-exec` prints `sandbox-exec: ` to its own stderr and
 * exits non-zero when it cannot `execve()` the wrapped command at all —
 * missing binary, `EACCES`, or a profile the kernel refused to compile — so
 * the wrapped program never starts and never contributes any output of its
 * own. A caller that wrapped a spawn checks this on `close` to tell "the
 * command could not start" apart from "the command started and merely
 * exited non-zero", the same distinction the unwrapped path already gets
 * for free from `spawn`'s own `error` event — wrapping trades that event
 * for this stderr signature, because `sandbox-exec` itself is always the
 * process Node spawns, so Node's own spawn bookkeeping only ever reports
 * success.
 * @param stderr - captured stderr of a sandbox-wrapped child, decoded as text.
 * @returns true when the text contains `sandbox-exec`'s own diagnostic prefix.
 */
export function sandboxLaunchFailed(stderr: string): boolean {
  return stderr.includes('sandbox-exec: ')
}

/** Inputs a confined executor or acceptance-case spawn resolves its profile from. */
export interface SandboxRunRoots {
  /** The deployment's sandbox configuration (already defaulted by the caller when the deployment configured none). */
  readonly sandbox: SandboxConfig
  /** Absolute, already-resolved experiment worktree the spawn runs in and may write. */
  readonly worktreeReal: string
  /** Absolute, already-resolved data directory the spawn receives as `DSH_HOME` and may write. */
  readonly dshHomeReal: string
}

/** One resolved Seatbelt profile, ready to wrap a spawn or to digest for evidence. */
export interface PreparedSandbox {
  /** Full SBPL profile text. */
  readonly profile: string
  /** sha-256 hex digest of `profile`, recorded on attempt evidence instead of the full path list. */
  readonly profileDigest: string
}

/**
 * Resolve the full Seatbelt profile for one confined spawn. Writable roots
 * are the worktree, the attempt's data directory, every temp-directory
 * spelling this host carries (`/private/tmp`, `/tmp`, `os.tmpdir()`, and
 * `$TMPDIR` when set — kept as separate candidates because Seatbelt's
 * subpath match needs the same resolved spelling the wrapped process' own
 * syscalls resolve to, and `/tmp` and `os.tmpdir()` can resolve through
 * different symlinked ancestors on the same host), and the deployment's
 * `extraWritableRoots`. Deny-read roots come straight from the deployment.
 * Every candidate is resolved with {@link resolveSandboxRoot} before it
 * reaches {@link buildSeatbeltProfile}.
 * @param input - the deployment's sandbox configuration and this spawn's resolved worktree and data directory.
 * @returns the profile text and its digest.
 */
export async function prepareSandboxProfile(input: SandboxRunRoots): Promise<PreparedSandbox> {
  const tmpEnv = process.env.TMPDIR
  const writableCandidates = [
    input.worktreeReal,
    input.dshHomeReal,
    '/private/tmp',
    '/tmp',
    tmpdir(),
    ...(tmpEnv === undefined || tmpEnv.length === 0 ? [] : [tmpEnv]),
    ...input.sandbox.extraWritableRoots,
  ]
  const [writableRoots, denyReadRoots] = await Promise.all([
    Promise.all(writableCandidates.map(root => resolveSandboxRoot(root))),
    Promise.all(input.sandbox.denyReadRoots.map(root => resolveSandboxRoot(root))),
  ])
  const profile = buildSeatbeltProfile({ writableRoots, denyReadRoots })
  const profileDigest = createHash('sha256').update(profile, 'utf8').digest('hex')
  return { profile, profileDigest }
}

/**
 * Resolve the Seatbelt profile for `roots` and spawn `program`/`args`
 * confined by it. The executor's headless child and every acceptance-case
 * process call this one function so there is exactly one path from "what
 * roots may this spawn touch" to "what actually ran" — a caller cannot wrap
 * a command with a profile built from different roots than the ones it
 * passes to `spawn`.
 * @param sandbox - the deployment's sandbox configuration (already checked available by the caller).
 * @param roots - this spawn's resolved worktree and data directory.
 * @param program - the unwrapped program to run.
 * @param args - the unwrapped program's arguments.
 * @param options - spawn options, identical to the unconfined call the caller would otherwise make.
 * @returns the spawned (already-confined) child process.
 */
export async function spawnConfined(
  sandbox: SandboxConfig,
  roots: { readonly worktreeReal: string; readonly dshHomeReal: string },
  program: string,
  args: readonly string[],
  options: SpawnOptionsWithStdioTuple<'ignore', 'pipe', 'pipe'>,
): Promise<ChildProcessByStdio<null, Readable, Readable>> {
  const prepared = await prepareSandboxProfile({ sandbox, worktreeReal: roots.worktreeReal, dshHomeReal: roots.dshHomeReal })
  const wrapped = wrapCommand(sandbox.sandboxExec, prepared.profile, [program, ...args])
  return spawn(wrapped[0], wrapped.slice(1), options)
}
