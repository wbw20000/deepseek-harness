/**
 * Worktree digest behavior: source snapshots over HEAD, the working diff,
 * and untracked files, plus stable artifact digests over explicit paths.
 * Fixtures are temporary git repositories, removed after every test.
 * @module digests.spec
 */

import { spawnSync } from 'node:child_process'
import { unlinkSync } from 'node:fs'
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { artifactDigestOf, sourceDigestOf } from '../src/digests.ts'
import { SelfDevelopmentRunnerError } from '../src/runtime.ts'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawnSync: vi.fn((...args: Parameters<typeof actual.spawnSync>) => actual.spawnSync(...args)) }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    lstat: vi.fn((...args: Parameters<typeof actual.lstat>) => actual.lstat(...args)),
    realpath: vi.fn((...args: Parameters<typeof actual.realpath>) => actual.realpath(...args)),
    readFile: vi.fn((...args: Parameters<typeof actual.readFile>) => actual.readFile(...args)),
  }
})

let root: string | undefined
/** Extra temporary roots (outside the worktree) created by a running test. */
const extraRoots: string[] = []

afterEach(async () => {
  for (const extra of extraRoots) await rm(extra, { recursive: true, force: true })
  extraRoots.length = 0
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

  it('refuses an empty repository without any commit', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'self-dev-empty-'))
    root = empty
    git(empty, ['init', '-q'])
    await expect(sourceDigestOf(empty)).rejects.toThrow(SelfDevelopmentRunnerError)
    await expect(sourceDigestOf(empty)).rejects.toThrow(expect.objectContaining({ code: 'SELF_DEV_RUNNER_WORKTREE_INVALID' }))
  })

  it('reports a git command that failed without stderr as a worktree error', async () => {
    const worktree = await makeWorktree()
    const failed = () => ({
      error: undefined,
      status: 1,
      signal: null,
      stdout: Buffer.from(''),
      stderr: Buffer.from(''),
    }) as unknown as ReturnType<typeof spawnSync>
    vi.mocked(spawnSync).mockImplementationOnce(failed).mockImplementationOnce(failed)
    await expect(sourceDigestOf(worktree)).rejects.toThrow(/git rev-parse HEAD .* failed: exit status 1/)
    await expect(sourceDigestOf(worktree)).rejects.toThrow(expect.objectContaining({ code: 'SELF_DEV_RUNNER_WORKTREE_INVALID' }))
  })

  it('reports a git maxBuffer overflow as a worktree error instead of digesting truncated output', async () => {
    const worktree = await makeWorktree()
    const overflow = () => ({
      error: Object.assign(new Error('spawn git ENOBUFS'), { code: 'ENOBUFS' }),
      status: null,
      signal: null,
      stdout: Buffer.from('truncated'),
      stderr: Buffer.from(''),
    }) as unknown as ReturnType<typeof spawnSync>
    vi.mocked(spawnSync).mockImplementationOnce(overflow).mockImplementationOnce(overflow)
    await expect(sourceDigestOf(worktree)).rejects.toThrow(/git rev-parse HEAD .* failed: .*ENOBUFS/)
    await expect(sourceDigestOf(worktree)).rejects.toThrow(expect.objectContaining({ code: 'SELF_DEV_RUNNER_WORKTREE_INVALID' }))
  })

  it('reports a git command that never exits as a worktree error', async () => {
    const worktree = await makeWorktree()
    const killed = () => ({
      error: undefined,
      status: null,
      signal: 'SIGTERM',
      stdout: Buffer.from(''),
      stderr: Buffer.from(''),
    }) as unknown as ReturnType<typeof spawnSync>
    vi.mocked(spawnSync).mockImplementationOnce(killed).mockImplementationOnce(killed)
    await expect(sourceDigestOf(worktree)).rejects.toThrow(/git rev-parse HEAD .* failed: timed out or could not start/)
    await expect(sourceDigestOf(worktree)).rejects.toThrow(expect.objectContaining({ code: 'SELF_DEV_RUNNER_WORKTREE_INVALID' }))
  })

  it('refuses an untracked symlink that points outside the worktree', async () => {
    const worktree = await makeWorktree()
    await symlink('/etc/hosts', join(worktree, 'escape.txt'))
    await expect(sourceDigestOf(worktree)).rejects.toThrow(/escape\.txt/)
    await expect(sourceDigestOf(worktree)).rejects.toThrow(expect.objectContaining({ code: 'SELF_DEV_RUNNER_WORKTREE_INVALID' }))
  })

  it('refuses an untracked dangling symlink', async () => {
    const worktree = await makeWorktree()
    await symlink('nowhere.txt', join(worktree, 'dangling.txt'))
    await expect(sourceDigestOf(worktree)).rejects.toThrow(/dangling\.txt/)
    await expect(sourceDigestOf(worktree)).rejects.toThrow(expect.objectContaining({ code: 'SELF_DEV_RUNNER_WORKTREE_INVALID' }))
  })

  it('refuses an untracked file that disappears before it is read', async () => {
    const worktree = await makeWorktree()
    await writeFile(join(worktree, 'ghost.txt'), 'gone\n')
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
    vi.mocked(spawnSync)
      .mockImplementationOnce(actual.spawnSync)
      .mockImplementationOnce(actual.spawnSync)
      .mockImplementationOnce((...args: Parameters<typeof spawnSync>) => {
        const result = actual.spawnSync(...args)
        unlinkSync(join(worktree, 'ghost.txt'))
        return result
      })
    const pending = sourceDigestOf(worktree)
    await expect(pending).rejects.toThrow(/ghost\.txt/)
    await expect(pending).rejects.toThrow(expect.objectContaining({ code: 'SELF_DEV_RUNNER_WORKTREE_INVALID' }))
  })

  it('wraps a failed read of an untracked plain file as a worktree error', async () => {
    const worktree = await makeWorktree()
    await writeFile(join(worktree, 'ghost.txt'), 'gone\n')
    // The entry survives the lstat probe but is deleted before readFile: the
    // race must surface as a worktree error, not a bare ENOENT.
    // Both reads fail, one per sourceDigestOf call below.
    vi.mocked(readFile).mockRejectedValueOnce(Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }))
    vi.mocked(readFile).mockRejectedValueOnce(Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }))
    await expect(sourceDigestOf(worktree)).rejects.toThrow(/ghost\.txt/)
    await expect(sourceDigestOf(worktree)).rejects.toThrow(expect.objectContaining({ code: 'SELF_DEV_RUNNER_WORKTREE_INVALID' }))
  })

  it('digests an untracked symlink that stays inside the worktree', async () => {
    const worktree = await makeWorktree()
    await symlink('tracked.txt', join(worktree, 'inner.txt'))
    expect(await sourceDigestOf(worktree)).toBe(await sourceDigestOf(worktree))
  })

  it('accepts an internal two-dot-prefixed filename and a link to it', async () => {
    const worktree = await makeWorktree()
    await writeFile(join(worktree, '..notes'), 'internal')
    await symlink('..notes', join(worktree, 'notes-link'))
    expect(await sourceDigestOf(worktree)).toMatch(/^[0-9a-f]{64}$/)
    expect(await artifactDigestOf(worktree, ['..notes'])).toMatch(/^[0-9a-f]{64}$/)
  })

  it('classifies a failed read through an internal symlink', async () => {
    const worktree = await makeWorktree()
    await symlink('tracked.txt', join(worktree, 'link'))
    vi.mocked(readFile).mockRejectedValueOnce(Object.assign(new Error('target vanished'), { code: 'ENOENT' }))
    await expect(sourceDigestOf(worktree)).rejects.toMatchObject({ code: 'SELF_DEV_RUNNER_WORKTREE_INVALID' })
  })

  it('classifies an entry disappearing between content read and metadata collection', async () => {
    const worktree = await makeWorktree()
    const target = join(worktree, 'vanishing')
    await writeFile(target, 'content')
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(readFile).mockImplementationOnce(async (...args: Parameters<typeof readFile>) => {
      const content = await actual.readFile(...args)
      unlinkSync(target)
      return content
    })
    await expect(sourceDigestOf(worktree)).rejects.toMatchObject({ code: 'SELF_DEV_RUNNER_WORKTREE_INVALID' })
  })

  it('refuses an untracked symlink to a directory', async () => {
    const worktree = await makeWorktree()
    await symlink('.', join(worktree, 'directory-link'))
    await expect(sourceDigestOf(worktree)).rejects.toMatchObject({ code: 'SELF_DEV_RUNNER_WORKTREE_INVALID' })
  })

  it.skipIf(process.platform === 'win32')('refuses a source replaced by a FIFO and FIFO artifacts without opening them', async () => {
    const worktree = await makeWorktree()
    await mkdir(join(worktree, 'pipes'))
    const target = join(worktree, 'pipes', 'input')
    await writeFile(target, 'regular at listing')
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
    vi.mocked(spawnSync).mockImplementationOnce(actual.spawnSync).mockImplementationOnce(actual.spawnSync)
      .mockImplementationOnce((...args: Parameters<typeof spawnSync>) => {
        const listing = actual.spawnSync(...args)
        unlinkSync(target)
        expect(actual.spawnSync('mkfifo', [target], { timeout: 2000 }).status).toBe(0)
        return listing
      })
    await expect(sourceDigestOf(worktree)).rejects.toMatchObject({ code: 'SELF_DEV_RUNNER_WORKTREE_INVALID' })
    await expect(artifactDigestOf(worktree, ['pipes/input'])).rejects.toMatchObject({ code: 'SELF_DEV_RUNNER_WORKTREE_INVALID' })
    await expect(artifactDigestOf(worktree, ['pipes'])).rejects.toMatchObject({ code: 'SELF_DEV_RUNNER_WORKTREE_INVALID' })
  })

  it('refuses an untracked file when its ancestor is replaced after the git listing', async () => {
    const worktree = await makeWorktree()
    await mkdir(join(worktree, 'nested'))
    await writeFile(join(worktree, 'nested', 'file'), 'before')
    const outside = await mkdtemp(join(tmpdir(), 'self-dev-source-outside-'))
    extraRoots.push(outside)
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
    const { rmSync, symlinkSync } = await import('node:fs')
    vi.mocked(spawnSync).mockImplementationOnce((...args) => actual.spawnSync(...args))
      .mockImplementationOnce((...args) => actual.spawnSync(...args))
      .mockImplementationOnce((...args) => {
        const listing = actual.spawnSync(...args)
        rmSync(join(worktree, 'nested'), { recursive: true })
        symlinkSync(outside, join(worktree, 'nested'))
        return listing
      })
    await expect(sourceDigestOf(worktree)).rejects.toMatchObject({ code: 'SELF_DEV_RUNNER_WORKTREE_INVALID' })
  })
})

describe('artifactDigestOf', () => {
  it.each([Object.assign(new Error('denied'), { code: 'EACCES' }), null, 'failed'])('does not label an unreadable artifact as absent: %s', async (error) => {
    const worktree = await makeWorktree()
    vi.mocked(lstat).mockRejectedValueOnce(error)
    await expect(artifactDigestOf(worktree, ['tracked.txt'])).rejects.toMatchObject({ code: 'SELF_DEV_RUNNER_WORKTREE_INVALID' })
  })

  it('records an absent artifact beneath a non-directory parent', async () => {
    const worktree = await makeWorktree()
    expect(await artifactDigestOf(worktree, ['tracked.txt/missing'])).toMatch(/^[0-9a-f]{64}$/)
  })
  it('refuses artifact paths reached through an outside ancestor', async () => {
    const worktree = await makeWorktree()
    const outside = await mkdtemp(join(tmpdir(), 'self-dev-artifact-outside-'))
    extraRoots.push(outside)
    await writeFile(join(outside, 'canary.txt'), 'outside')
    await symlink(outside, join(worktree, 'escape'))
    await expect(artifactDigestOf(worktree, ['escape/canary.txt'])).rejects.toMatchObject({ code: 'SELF_DEV_RUNNER_WORKTREE_INVALID' })
  })
  it.each([
    ['parent escape', '../outside.txt'],
    ['parent directory', '..'],
    ['absolute path', '/etc/hosts'],
    ['worktree root', '.'],
  ])('refuses an artifact path with %s', async (_name, requested) => {
    const worktree = await makeWorktree()
    await expect(artifactDigestOf(worktree, [requested]))
      .rejects.toThrow(SelfDevelopmentRunnerError)
    await expect(artifactDigestOf(worktree, [requested]))
      .rejects.toThrow(expect.objectContaining({ code: 'SELF_DEV_RUNNER_WORKTREE_INVALID' }))
  })

  it('digests equivalent spellings of the same path identically', async () => {
    const worktree = await makeWorktree()
    await mkdir(join(worktree, 'dist'))
    await writeFile(join(worktree, 'dist', 'a.js'), 'a\n')
    expect(await artifactDigestOf(worktree, ['./dist'])).toBe(await artifactDigestOf(worktree, ['dist']))
    expect(await artifactDigestOf(worktree, ['./tracked.txt'])).toBe(await artifactDigestOf(worktree, ['tracked.txt']))
    expect(await artifactDigestOf(worktree, ['dist/../tracked.txt'])).toBe(await artifactDigestOf(worktree, ['tracked.txt']))
  })

  it('digests a trailing-slash spelling of a file path identically to the bare name', async () => {
    const worktree = await makeWorktree()
    await mkdir(join(worktree, 'dist'))
    await writeFile(join(worktree, 'dist', 'a.js'), 'a\n')
    expect(await artifactDigestOf(worktree, ['tracked.txt/'])).toBe(await artifactDigestOf(worktree, ['tracked.txt']))
    expect(await artifactDigestOf(worktree, ['dist/'])).toBe(await artifactDigestOf(worktree, ['dist']))
  })

  it('records a symlink artifact without reading its target', async () => {
    const worktree = await makeWorktree()
    const outside = await mkdtemp(join(tmpdir(), 'self-dev-outside-'))
    extraRoots.push(outside)
    await writeFile(join(outside, 'a.txt'), 'outer-a\n')
    await writeFile(join(outside, 'b.txt'), 'outer-b\n')
    await symlink(join(outside, 'a.txt'), join(worktree, 'link.txt'))
    const asLink = await artifactDigestOf(worktree, ['link.txt'])
    expect(await artifactDigestOf(worktree, ['link.txt'])).toBe(asLink)
    // The link text is part of identity; external target bytes are not read.
    await rm(join(worktree, 'link.txt'))
    await symlink(join(outside, 'b.txt'), join(worktree, 'link.txt'))
    expect(await artifactDigestOf(worktree, ['link.txt'])).not.toBe(asLink)
    // The same bytes read from a plain file digest differently from the
    // symlink record, so following the link would be observable here.
    await writeFile(join(worktree, 'plain.txt'), 'outer-a\n')
    expect(await artifactDigestOf(worktree, ['plain.txt'])).not.toBe(asLink)
  })

  it('records a symlink found inside a digested directory tree without reading its target', async () => {
    const worktree = await makeWorktree()
    const outside = await mkdtemp(join(tmpdir(), 'self-dev-outside-'))
    extraRoots.push(outside)
    await writeFile(join(outside, 'deep.txt'), 'outer-deep\n')
    await mkdir(join(worktree, 'dist'))
    await writeFile(join(worktree, 'dist', 'a.js'), 'a\n')
    await symlink(join(outside, 'deep.txt'), join(worktree, 'dist', 'link.txt'))
    const tree = await artifactDigestOf(worktree, ['dist'])
    expect(await artifactDigestOf(worktree, ['dist'])).toBe(tree)
    await rm(join(worktree, 'dist', 'link.txt'))
    await writeFile(join(outside, 'deep.txt'), 'outer-deep-changed\n')
    await symlink(join(outside, 'deep.txt'), join(worktree, 'dist', 'link.txt'))
    expect(await artifactDigestOf(worktree, ['dist'])).toBe(tree)
  })

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
