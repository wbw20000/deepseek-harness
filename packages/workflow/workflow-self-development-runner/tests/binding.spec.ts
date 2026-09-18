/**
 * Launch-fact binding: a human confirmation binds the real filesystem launch
 * facts (task, worktree realpath, digests, artifact path set), and an
 * experiment worktree must resolve inside the experiments root with a `.git`
 * entry.
 * @module binding.spec
 */

import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertConfirmationBinds, resolveExperimentWorktree } from '../src/binding.ts'
import type { LaunchFacts } from '../src/binding.ts'
import type { PresenceConfirmation } from '../src/presence.ts'
import { SelfDevelopmentRunnerError } from '../src/runtime.ts'

const BOOT_ID = 'a'.repeat(64)
const PLAN_DIGEST = 'b'.repeat(64)
const ACCEPTANCE_DIGEST = 'c'.repeat(64)

const confirmation = (worktree: string, overrides: Partial<PresenceConfirmation> = {}): PresenceConfirmation => ({
  confirmedBy: 'operator-1',
  confirmedAt: { bootId: BOOT_ID, monotonicMs: 1234 },
  worktree,
  loopbackAllowlist: [4173],
  acknowledgement: 'supervised-not-unattended',
  taskId: 'task-1',
  testPlanDigest: PLAN_DIGEST,
  acceptanceDefinitionDigest: ACCEPTANCE_DIGEST,
  artifactPaths: ['dist/cli.js', 'lib'],
  ...overrides,
})

const facts = (worktreeReal: string, overrides: Partial<LaunchFacts> = {}): LaunchFacts => ({
  taskId: 'task-1',
  worktreeReal,
  testPlanDigest: PLAN_DIGEST,
  acceptanceDefinitionDigest: ACCEPTANCE_DIGEST,
  artifactPaths: ['dist/cli.js', 'lib'],
  ...overrides,
})

const errorCode = async (run: () => Promise<unknown>): Promise<SelfDevelopmentRunnerError> => {
  try {
    await run()
  } catch (error) {
    expect(error).toBeInstanceOf(SelfDevelopmentRunnerError)
    return error as SelfDevelopmentRunnerError
  }
  throw new Error('expected the call to reject')
}

let root: string | undefined
let worktreeReal: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-binding-'))
  const created = join(root, 'wt-1')
  await mkdir(created)
  await writeFile(join(created, '.git'), 'gitdir: /elsewhere/worktrees/wt-1.git\n')
  worktreeReal = await realpath(created)
})

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('assertConfirmationBinds', () => {
  it('accepts a confirmation whose facts match the launch', async () => {
    await expect(assertConfirmationBinds(confirmation(worktreeReal), facts(worktreeReal))).resolves.toBeUndefined()
  })

  it('judges artifact paths as a set, ignoring order and repeats in the launch facts', async () => {
    const scrambled = facts(worktreeReal, { artifactPaths: ['lib', 'dist/cli.js', 'lib'] })
    await expect(assertConfirmationBinds(confirmation(worktreeReal), scrambled)).resolves.toBeUndefined()
  })

  it('accepts a confirmation whose worktree path is a symlink to the launched worktree', async () => {
    const link = join(root as string, 'wt-link')
    await symlink(worktreeReal, link)
    await expect(assertConfirmationBinds(confirmation(link), facts(worktreeReal))).resolves.toBeUndefined()
  })

  it('rejects a different task id', async () => {
    const error = await errorCode(() => assertConfirmationBinds(confirmation(worktreeReal), facts(worktreeReal, { taskId: 'task-2' })))
    expect(error.code).toBe('SELF_DEV_RUNNER_PRESENCE_MISMATCH')
    expect(error.message).toContain('taskId')
  })

  it('rejects a worktree that resolves somewhere else', async () => {
    const other = join(root as string, 'wt-other')
    await mkdir(other)
    const error = await errorCode(() => assertConfirmationBinds(confirmation(other), facts(worktreeReal)))
    expect(error.code).toBe('SELF_DEV_RUNNER_PRESENCE_MISMATCH')
    expect(error.message).toContain('worktree')
  })

  it('rejects a worktree path that does not resolve', async () => {
    const error = await errorCode(() => assertConfirmationBinds(confirmation(join(root as string, 'missing')), facts(worktreeReal)))
    expect(error.code).toBe('SELF_DEV_RUNNER_PRESENCE_MISMATCH')
    expect(error.message).toContain('worktree')
  })

  it('rejects a different test plan digest', async () => {
    const error = await errorCode(() => assertConfirmationBinds(
      confirmation(worktreeReal, { testPlanDigest: 'd'.repeat(64) }),
      facts(worktreeReal),
    ))
    expect(error.code).toBe('SELF_DEV_RUNNER_PRESENCE_MISMATCH')
    expect(error.message).toContain('testPlanDigest')
  })

  it('rejects a different acceptance definition digest', async () => {
    const error = await errorCode(() => assertConfirmationBinds(
      confirmation(worktreeReal, { acceptanceDefinitionDigest: 'd'.repeat(64) }),
      facts(worktreeReal),
    ))
    expect(error.code).toBe('SELF_DEV_RUNNER_PRESENCE_MISMATCH')
    expect(error.message).toContain('acceptanceDefinitionDigest')
  })

  it('rejects launch facts missing one artifact path', async () => {
    const error = await errorCode(() => assertConfirmationBinds(confirmation(worktreeReal), facts(worktreeReal, { artifactPaths: ['dist/cli.js'] })))
    expect(error.code).toBe('SELF_DEV_RUNNER_PRESENCE_MISMATCH')
    expect(error.message).toContain('artifactPaths')
  })

  it('rejects launch facts carrying one extra artifact path', async () => {
    const error = await errorCode(() => assertConfirmationBinds(
      confirmation(worktreeReal),
      facts(worktreeReal, { artifactPaths: ['dist/cli.js', 'lib', 'extra'] }),
    ))
    expect(error.code).toBe('SELF_DEV_RUNNER_PRESENCE_MISMATCH')
    expect(error.message).toContain('artifactPaths')
  })
})

describe('resolveExperimentWorktree', () => {
  it('returns the realpath of a worktree inside the experiments root', async () => {
    const resolved = await resolveExperimentWorktree(root as string, worktreeReal)
    expect(resolved).toBe(await realpath(worktreeReal))
  })

  it('accepts a worktree directory whose name begins with two dots', async () => {
    const dotsName = join(root as string, '..dot-name')
    await mkdir(dotsName)
    await writeFile(join(dotsName, '.git'), 'gitdir: /elsewhere/worktrees/dots.git\n')
    const resolved = await resolveExperimentWorktree(root as string, dotsName)
    expect(resolved).toBe(await realpath(dotsName))
  })

  it('accepts a symlinked worktree that resolves inside the experiments root', async () => {
    const link = join(root as string, 'wt-link')
    await symlink(worktreeReal, link)
    const resolved = await resolveExperimentWorktree(root as string, link)
    expect(resolved).toBe(await realpath(worktreeReal))
  })

  it('rejects a directory outside the experiments root', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'dsh-binding-outside-'))
    try {
      await writeFile(join(outside, '.git'), 'gitdir: /elsewhere/worktrees/out.git\n')
      expect((await errorCode(() => resolveExperimentWorktree(root as string, outside))).code).toBe('SELF_DEV_RUNNER_WORKTREE_INVALID')
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('rejects a symlinked worktree that resolves outside the experiments root', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'dsh-binding-outside-'))
    try {
      await writeFile(join(outside, '.git'), 'gitdir: /elsewhere/worktrees/out.git\n')
      const link = join(root as string, 'escape')
      await symlink(outside, link)
      expect((await errorCode(() => resolveExperimentWorktree(root as string, link))).code).toBe('SELF_DEV_RUNNER_WORKTREE_INVALID')
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('rejects a directory without a .git entry', async () => {
    const plain = join(root as string, 'plain')
    await mkdir(plain)
    expect((await errorCode(() => resolveExperimentWorktree(root as string, plain))).code).toBe('SELF_DEV_RUNNER_WORKTREE_INVALID')
  })
})
