/**
 * Worktree digest behavior: source snapshots over HEAD, the working diff,
 * and untracked files, plus stable artifact digests over explicit paths.
 * Fixtures are temporary git repositories, removed after every test.
 * @module digests.spec
 */

import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { artifactDigestOf, sourceDigestOf } from '../src/digests.ts'
import { SelfDevelopmentRunnerError } from '../src/runtime.ts'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Run one git command inside the fixture repository. */
function git(worktree: string, args: readonly string[]): void {
  const result = spawnSync('git', ['-C', worktree, ...args], { stdio: 'pipe' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString('utf8')}`)
}

/** Create a temporary git repository with one committed file. */
async function makeWorktree(): Promise<string> {
  const worktree = await mkdtemp(join(tmpdir(), 'self-dev-digests-'))
  root = worktree
  git(worktree, ['init', '-q'])
  git(worktree, ['-c', 'user.email=fixture@example.com', '-c', 'user.name=fixture', 'commit', '--allow-empty', '-q', '-m', 'baseline'])
  await writeFile(join(worktree, 'tracked.txt'), 'one\n')
  git(worktree, ['add', 'tracked.txt'])
  git(worktree, ['-c', 'user.email=fixture@example.com', '-c', 'user.name=fixture', 'commit', '-q', '-m', 'add tracked'])
  return worktree
}

describe('sourceDigestOf', () => {
  it('returns the same digest for the same worktree state', async () => {
    const worktree = await makeWorktree()
    expect(await sourceDigestOf(worktree)).toBe(await sourceDigestOf(worktree))
  })

  it('changes when a tracked file is modified without committing', async () => {
    const worktree = await makeWorktree()
    const before = await sourceDigestOf(worktree)
    await writeFile(join(worktree, 'tracked.txt'), 'two\n')
    expect(await sourceDigestOf(worktree)).not.toBe(before)
  })

  it('changes when an untracked file appears', async () => {
    const worktree = await makeWorktree()
    const before = await sourceDigestOf(worktree)
    await writeFile(join(worktree, 'extra.txt'), 'untracked\n')
    expect(await sourceDigestOf(worktree)).not.toBe(before)
  })

  it('ignores files excluded by .gitignore', async () => {
    const worktree = await makeWorktree()
    await writeFile(join(worktree, '.gitignore'), 'ignored.log\n')
    git(worktree, ['add', '.gitignore'])
    git(worktree, ['-c', 'user.email=fixture@example.com', '-c', 'user.name=fixture', 'commit', '-q', '-m', 'ignore log'])
    const before = await sourceDigestOf(worktree)
    await writeFile(join(worktree, 'ignored.log'), 'noise\n')
    expect(await sourceDigestOf(worktree)).toBe(before)
  })

  it('refuses a directory that is not a git worktree', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'self-dev-nogit-'))
    root = plain
    await expect(sourceDigestOf(plain)).rejects.toThrow(SelfDevelopmentRunnerError)
    await expect(sourceDigestOf(plain)).rejects.toThrow(expect.objectContaining({ code: 'SELF_DEV_RUNNER_WORKTREE_INVALID' }))
  })
})

describe('artifactDigestOf', () => {
  it('digests a file, a directory tree, and a missing path stably and distinctly', async () => {
    const worktree = await makeWorktree()
    await mkdir(join(worktree, 'dist', 'nested'), { recursive: true })
    await writeFile(join(worktree, 'dist', 'a.js'), 'a\n')
    await writeFile(join(worktree, 'dist', 'b.js'), 'b\n')
    await writeFile(join(worktree, 'dist', 'nested', 'c.js'), 'c\n')

    const file = await artifactDigestOf(worktree, ['tracked.txt'])
    expect(file).toBe(await artifactDigestOf(worktree, ['tracked.txt']))

    const tree = await artifactDigestOf(worktree, ['dist'])
    expect(tree).toBe(await artifactDigestOf(worktree, ['dist']))
    expect(tree).not.toBe(file)

    const missing = await artifactDigestOf(worktree, ['missing.bin'])
    expect(missing).toBe(await artifactDigestOf(worktree, ['missing.bin']))
    expect(missing).not.toBe(file)
  })

  it('normalizes the path order and keeps the digest independent of argument order', async () => {
    const worktree = await makeWorktree()
    await mkdir(join(worktree, 'dist'))
    await writeFile(join(worktree, 'dist', 'a.js'), 'a\n')
    const forward = await artifactDigestOf(worktree, ['dist', 'tracked.txt'])
    expect(await artifactDigestOf(worktree, ['tracked.txt', 'dist'])).toBe(forward)
  })

  it('changes when a digested artifact changes but not when other files do', async () => {
    const worktree = await makeWorktree()
    await mkdir(join(worktree, 'dist'))
    await writeFile(join(worktree, 'dist', 'a.js'), 'a\n')
    const before = await artifactDigestOf(worktree, ['dist', 'tracked.txt'])
    await writeFile(join(worktree, 'unrelated.txt'), 'noise\n')
    expect(await artifactDigestOf(worktree, ['dist', 'tracked.txt'])).toBe(before)
    await writeFile(join(worktree, 'dist', 'a.js'), 'changed\n')
    expect(await artifactDigestOf(worktree, ['dist', 'tracked.txt'])).not.toBe(before)
  })
})

describe('digest format', () => {
  it('returns lowercase 64-hex digests for both kinds', async () => {
    const worktree = await makeWorktree()
    const source = await sourceDigestOf(worktree)
    const artifact = await artifactDigestOf(worktree, ['tracked.txt'])
    expect(source).toMatch(/^[0-9a-f]{64}$/)
    expect(artifact).toMatch(/^[0-9a-f]{64}$/)
    expect(await readFile(join(worktree, 'tracked.txt'), 'utf8')).toBe('one\n')
  })
})
