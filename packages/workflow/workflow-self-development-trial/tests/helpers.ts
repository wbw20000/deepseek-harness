/**
 * Temporary-directory fixtures for the trial-manager tests: a fake DSH
 * worktree whose `apps/cli/lib/bin.js` prints the readiness line like the
 * real CLI and whose `node_modules/.bin/pnpm` is a controllable build
 * script, plus a free-port scanner for the configured range.
 * @module helpers
 */

import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { join } from 'node:path'
import type { OpenTrialResult, TrialConfig } from '../src/types.ts'

/**
 * Narrow an `OpenTrialResult` to its successful shape for a test that always
 * expects one; the union has no `port`/`pid` on its refusal branch, so
 * asserting the discriminant here is what lets the rest of the test read
 * them without repeating the guard.
 * @param result - the raw `openTrial` result.
 * @returns the same result, typed to its `{ url: string; port: number; pid: number }` branch.
 * @throws when the result was the `{ url: undefined; reason }` refusal branch instead.
 */
export function expectOpened(result: OpenTrialResult): { url: string; port: number; pid: number } {
  if (result.url === undefined) {
    throw new Error(`expected an opened trial instance, got a refusal: ${result.reason}`)
  }
  return result
}

/** Web-process behaviors the fake CLI bin can be generated with. */
export type FakeBinMode = 'ready' | 'exit-first' | 'exit-later'

/** Build-script behaviors the fake worktree pnpm can be generated with. */
export type FakePnpmMode = 'ok' | 'fail' | 'slow' | 'signal' | 'none'

/** One temporary environment: base directory plus manager-ready paths. */
export interface TrialEnvironment {
  /** Temporary root every fixture lives under. */
  readonly base: string
  /** Absolute node binary the manager spawns the fake CLI with. */
  readonly nodeBinary: string
  /** Manager control directory under the base. */
  readonly controlDirectory: string
  /** A port range probed free at creation time. */
  readonly portRange: readonly [number, number]
}

/** One generated fake worktree and the paths the tests assert against. */
export interface FakeWorktree {
  /** Worktree root passed to the manager as the launch profile's worktree. */
  readonly root: string
  /** The fake CLI bin path (`apps/cli/lib/bin.js`). */
  readonly bin: string
}

/** Options for {@link makeWorktree}. */
export interface WorktreeOptions {
  /** Whether the root manifest names `@deepseek-ai/dsh-root`; default true. */
  readonly dshRoot?: boolean
  /** Write no root manifest at all when false. */
  readonly manifest?: boolean
  /** Fake CLI behavior; default `ready`. */
  readonly bin?: FakeBinMode
  /** Fake build behavior; default `ok`. */
  readonly pnpm?: FakePnpmMode
}

/** The fake CLI bin: announces its data home and the ready URL, then stays up until SIGTERM. */
function binScript(mode: FakeBinMode): string {
  return [
    'const args = process.argv.slice(2)',
    'const port = args[args.indexOf(\'--port\') + 1]',
    `if (${JSON.stringify(mode)} === 'exit-first') process.exit(0)`,
    'console.log(\'home=\' + (process.env.DSH_HOME ?? \'unset\'))',
    'console.log(\'dsh web: http://127.0.0.1:\' + port + \'/?token=abc\')',
    `if (${JSON.stringify(mode)} === 'exit-later') setTimeout(() => process.exit(0), 150)`,
    'process.on(\'SIGTERM\', () => process.exit(0))',
    'setInterval(() => {}, 1000)',
    '',
  ].join('\n')
}

/** The fake build script behind `node_modules/.bin/pnpm`. */
function pnpmScript(mode: Exclude<FakePnpmMode, 'none'>): string {
  switch (mode) {
    case 'ok': return 'process.stdout.write("building\\n")\n'
    case 'fail': return 'process.exit(3)\n'
    case 'slow': return 'setInterval(() => {}, 60000)\n'
    case 'signal': return 'process.kill(process.pid, "SIGKILL")\n'
  }
}

/**
 * Create one fake worktree under `base`.
 * @param base - temporary root.
 * @param name - directory name under the base.
 * @param options - manifest and script behaviors.
 * @returns the worktree root and its fake CLI bin path.
 */
export async function makeWorktree(base: string, name: string, options: WorktreeOptions = {}): Promise<FakeWorktree> {
  const root = join(base, name)
  const bin = join(root, 'apps', 'cli', 'lib', 'bin.js')
  await mkdir(join(root, 'apps', 'cli', 'lib'), { recursive: true })
  if (options.manifest !== false) {
    const name_ = options.dshRoot === false ? 'example-canvas' : '@deepseek-ai/dsh-root'
    await writeFile(join(root, 'package.json'), `${JSON.stringify({ name: name_, private: true }, null, 2)}\n`)
  }
  await writeFile(bin, binScript(options.bin ?? 'ready'))
  if (options.pnpm !== 'none') {
    const pnpm = join(root, 'node_modules', '.bin', 'pnpm')
    await mkdir(join(root, 'node_modules', '.bin'), { recursive: true })
    await writeFile(pnpm, `#!/usr/bin/env node\n${pnpmScript(options.pnpm ?? 'ok')}`)
    await chmod(pnpm, 0o755)
  }
  return { root, bin }
}

/**
 * Create one temporary environment with a probed-free port range.
 * @param prefix - temp-directory prefix.
 * @returns the environment paths.
 */
export async function makeEnvironment(prefix = 'dsh-trial-'): Promise<TrialEnvironment> {
  const base = await mkdtemp(join(tmpdir(), prefix))
  const bin = join(base, 'bin')
  await mkdir(bin, { recursive: true })
  // A private node binary without a corepack sibling, so the no-pnpm refusal
  // is deterministic regardless of the host installation.
  const nodeBinary = join(bin, 'node')
  await symlink(process.execPath, nodeBinary)
  const from = await freePort()
  return { base, nodeBinary, controlDirectory: join(base, 'control'), portRange: [from, from + 10] }
}

/** Manager configuration over one environment. */
export function trialConfig(environment: TrialEnvironment, overrides: Partial<TrialConfig> = {}): TrialConfig {
  return {
    nodeBinary: environment.nodeBinary,
    controlDirectory: environment.controlDirectory,
    portRange: environment.portRange,
    buildTimeoutMs: 60_000,
    readyTimeoutMs: 30_000,
    autoOpen: true,
    ...overrides,
  }
}

/**
 * Read one free loopback port by binding and releasing it.
 * @returns an unbound port number.
 */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => {
        if (port > 0) resolve(port)
        else reject(new Error('free-port probe got no port'))
      })
    })
  })
}

/**
 * Poll a predicate until it holds or the deadline passes.
 * @param predicate - condition to wait for.
 * @param timeoutMs - maximum wait; the promise rejects past it.
 * @returns resolves once the predicate holds.
 */
export async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('condition not reached within the deadline')
    await new Promise<void>((resolve) => { setTimeout(resolve, 15).unref?.() })
  }
}

/** Whether a process id is still live. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Remove one environment's temporary tree. */
export async function removeEnvironment(environment: TrialEnvironment): Promise<void> {
  await rm(environment.base, { recursive: true, force: true })
}
