/**
 * Shared test harness: a temporary sandbox with a git project, a data-home
 * template, and a validated workspaces config. Every spec works inside its
 * own `mkdtemp` directory and removes it on teardown.
 * @module harness
 */

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { WorkspacesConfig } from '../src/types.ts'

const execFileAsync = promisify(execFile)

/** One sandbox: the config plus the paths a spec needs to reach directly. */
export interface Sandbox {
  /** The temporary root everything lives under. */
  readonly root: string
  /** The validated workspaces config for the sandbox. */
  readonly config: WorkspacesConfig
  /** Absolute path of the sandbox's project repository. */
  readonly projectRoot: string
  /** Absolute path of the sandbox's data-home template. */
  readonly template: string
  /** The experiments root, for direct registry and lock inspection. */
  readonly experimentsRoot: string
}

/**
 * Run one git command with a fixed test committer identity.
 * @param cwd - absolute directory to run in.
 * @param args - git argument vector.
 * @returns the command's stdout.
 */
export function git(cwd: string, args: readonly string[]): Promise<string> {
  return execFileAsync('git', [
    '-c', 'user.email=test@example.invalid',
    '-c', 'user.name=test',
    ...args,
  ], { cwd }).then(result => result.stdout)
}

/**
 * Commit every change in a repository.
 * @param cwd - absolute repository directory.
 * @param message - commit message.
 * @returns the new commit id.
 */
export async function commitAll(cwd: string, message: string): Promise<string> {
  await execFileAsync('git', ['add', '-A'], { cwd })
  await git(cwd, ['commit', '-q', '-m', message])
  return (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim()
}

/**
 * Build one sandbox: temporary root, git project with one committed marker
 * file, populated data-home template, and a default two-task config.
 * @param overrides - config fields to override for the spec.
 * @returns the sandbox.
 */
export async function makeSandbox(overrides: Partial<WorkspacesConfig> = {}): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), 'self-dev-workspaces-'))
  const projectRoot = join(root, 'project')
  const template = join(root, 'template')
  const experimentsRoot = join(root, 'experiments')
  await mkdir(projectRoot, { recursive: true })
  await execFileAsync('git', ['init', '-q', '-b', 'main', projectRoot])
  await writeFile(join(projectRoot, 'marker.txt'), 'baseline\n')
  await commitAll(projectRoot, 'baseline')
  await mkdir(join(template, 'config'), { recursive: true })
  await writeFile(join(template, 'settings.json'), '{"theme":"dark"}\n')
  await writeFile(join(template, 'config', 'providers.json'), '[]\n')
  return {
    root,
    projectRoot,
    template,
    experimentsRoot,
    config: {
      experimentsRoot,
      dataHomeTemplate: template,
      maxConcurrentTasks: 2,
      ...overrides,
    },
  }
}

/**
 * Remove a sandbox and everything the spec created inside it.
 * @param sandbox - the sandbox to remove.
 */
export async function removeSandbox(sandbox: Sandbox): Promise<void> {
  await rm(sandbox.root, { recursive: true, force: true })
}
