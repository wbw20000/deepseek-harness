/**
 * Shared test harness for the Remote facade specs: one temporary control
 * directory, one real git experiment worktree, one stable-side acceptance
 * definition, and the validated service configs. Each spec owns its
 * environment and removes it afterwards.
 * @module helpers
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Root of the harness most recently built; the spec removes it after each test. */
export async function makeRoot(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

/** The acceptance definition every harness publishes: case `build` asserting the marker reads DONE. */
export function acceptanceDefinition(): string {
  return JSON.stringify({
    cases: [{
      caseId: 'build',
      command: ['node', fakeCase(), 'read', 'marker.txt'],
      timeoutMs: 10_000,
      assertions: [
        { assertionId: 'a1', kind: 'exit-code', expected: 0 },
        { assertionId: 'a2', kind: 'file-includes', path: 'marker.txt', text: 'DONE' },
      ],
    }],
  })
}

/** Absolute path of the fake headless CLI fixture the executor spawns. */
export function fakeDsh(): string {
  return fileURLToPath(new URL('./fixtures/fake-dsh-attempt.mjs', import.meta.url))
}

/** Absolute path of the fake acceptance command fixture the acceptor spawns. */
export function fakeCase(): string {
  return fileURLToPath(new URL('./fixtures/fake-case.mjs', import.meta.url))
}

/** Run one git command and fail the test on a nonzero exit. */
export async function runGit(args: readonly string[]): Promise<void> {
  await execFileAsync('git', args)
}

/** One booted harness: directories, worktree, acceptance definition, and the service configs. */
export interface Environment {
  /** Temporary root holding every harness file. */
  readonly base: string
  /** Control directory the task-control service owns. */
  readonly controlDirectory: string
  /** Experiment worktree as handed to the facade. */
  readonly worktree: string
  /** Absolute path of the acceptance definition. */
  readonly acceptancePath: string
  /** sha-256 hex digest of the acceptance definition bytes. */
  readonly acceptanceDefinitionDigest: string
  /** Runner configuration derived from the same root. */
  readonly runnerConfig: {
    readonly nodeBinary: string
    readonly dshBin: string
    readonly dshHome: string
    readonly experimentsRoot: string
    readonly evidenceRoot: string
    readonly killGraceMs: number
  }
}

/**
 * Build the harness files under a fresh temporary root.
 * @returns the environment every service config derives from.
 */
export async function makeEnvironment(): Promise<Environment> {
  const base = await makeRoot('self-dev-remote-')
  const experimentsRoot = join(base, 'experiments')
  const worktree = join(experimentsRoot, 'wt')
  await runGit(['init', '-q', '-b', 'main', worktree])
  await writeFile(join(worktree, 'marker.txt'), 'WIP')
  const identity = ['-c', 'user.email=e3@example.invalid', '-c', 'user.name=e3']
  await runGit(['-C', worktree, ...identity, 'add', 'marker.txt'])
  await runGit(['-C', worktree, ...identity, 'commit', '-q', '-m', 'baseline'])
  const definition = acceptanceDefinition()
  const acceptancePath = join(base, 'acceptance.json')
  await writeFile(acceptancePath, definition)
  return {
    base,
    controlDirectory: join(base, 'control'),
    worktree,
    acceptancePath,
    acceptanceDefinitionDigest: createHash('sha256').update(definition).digest('hex'),
    runnerConfig: {
      nodeBinary: process.execPath,
      dshBin: fakeDsh(),
      dshHome: join(base, 'dsh-home'),
      experimentsRoot,
      evidenceRoot: join(base, 'evidence'),
      killGraceMs: 400,
    },
  }
}

/** The stable-side `file://` base url the Loader resolves plugin config paths against. */
export function baseUrlOf(base: string): string {
  return `${pathToFileURL(base).href}/`
}
