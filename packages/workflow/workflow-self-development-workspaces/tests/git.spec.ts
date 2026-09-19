/**
 * Git helper behavior: explicit argv with no shell, captured output, a
 * wall-clock timeout that kills a stuck child, and boundary errors that carry
 * the failing command and stderr tail.
 * @module git.spec
 */

import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isAncestor, revParse, runGit } from '../src/git.ts'

let root: string | undefined
let savedPath: string | undefined

afterEach(async () => {
  if (savedPath !== undefined) {
    process.env.PATH = savedPath
    savedPath = undefined
  }
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Expect a rejected git call to carry the boundary code and a message fragment.
 * @param promise - the git call expected to reject.
 * @param fragment - regex the error message must match.
 */
async function expectGitFailure(promise: Promise<unknown>, fragment: RegExp): Promise<void> {
  const caught = await promise.then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(caught).toBeInstanceOf(Error)
  expect(caught).toMatchObject({ code: 'SELF_DEV_WORKSPACE_GIT_FAILED' })
  expect(caught instanceof Error ? caught.message : String(caught)).toMatch(fragment)
}

/** A git repository with two commits for ancestor checks. */
async function makeRepo(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'self-dev-git-'))
  const repo = join(root, 'repo')
  await mkdir(repo, { recursive: true })
  await runGit(repo, ['init', '-q', '-b', 'main'])
  await writeFile(join(repo, 'a.txt'), 'one\n')
  await runGit(repo, ['add', 'a.txt'])
  await runGit(repo, ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-qm', 'one'])
  await writeFile(join(repo, 'a.txt'), 'two\n')
  await runGit(repo, ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-qam', 'two'])
  return repo
}

/** A shim directory whose `git` runs the given script, prepended to PATH. */
async function makeShim(script: string): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'self-dev-git-'))
  const shim = join(root, 'shim')
  await mkdir(shim, { recursive: true })
  await writeFile(join(shim, 'git'), script)
  await chmod(join(shim, 'git'), 0o755)
  savedPath = process.env.PATH
  process.env.PATH = `${shim}:${savedPath ?? ''}`
}

describe('runGit', () => {
  it('runs a git command and captures its output', async () => {
    const repo = await makeRepo()
    const result = await runGit(repo, ['rev-parse', 'HEAD'])
    expect(result.stdout.trim()).toMatch(/^[0-9a-f]{40}$/)
    expect(result.stderr).toBe('')
  })

  it('passes flags through and reports failures with the stderr tail', async () => {
    const repo = await makeRepo()
    await expectGitFailure(runGit(repo, ['rev-parse', '--verify', 'no-such-ref']), /exit code/)
  })

  it('rejects through the spawn error path when git cannot be found', async () => {
    const repo = await makeRepo()
    savedPath = process.env.PATH
    process.env.PATH = join(root!, 'empty-bin')
    await mkdir(join(root!, 'empty-bin'), { recursive: true })
    await expectGitFailure(runGit(repo, ['status']), /could not spawn/)
  })

  it('kills a stuck child at the timeout', async () => {
    await makeShim('#!/bin/sh\nsleep 30\n')
    await mkdir(join(root!, 'repo'), { recursive: true })
    await expectGitFailure(runGit(join(root!, 'repo'), ['status'], 100), /timed out after 100ms/)
  })

  it('names the command head when a timeout hits an empty argv', async () => {
    await makeShim('#!/bin/sh\nsleep 30\n')
    await mkdir(join(root!, 'repo'), { recursive: true })
    await expectGitFailure(runGit(join(root!, 'repo'), [], 100), /git  timed out/)
  })

  it('reports a child that died from a signal', async () => {
    await makeShim('#!/bin/sh\nkill -TERM $$\n')
    await mkdir(join(root!, 'repo'), { recursive: true })
    await expectGitFailure(runGit(join(root!, 'repo'), ['status']), /signal/)
  })

  it('reports a failure without a stderr tail when git is quiet', async () => {
    const repo = await makeRepo()
    await expectGitFailure(runGit(repo, ['rev-parse', '--verify', '--quiet', 'no-such-ref']), /failed with exit code 1$/)
  })

  it('strips userinfo from URLs in the stderr tail', async () => {
    // A fetch failure whose remote URL embeds credentials must not carry them
    // into the boundary message.
    await makeShim('#!/bin/sh\necho "fatal: unable to access https://ci-bot:s3cr3t@example.invalid/repo.git/ authentication failure" >&2\nexit 1\n')
    await mkdir(join(root!, 'repo'), { recursive: true })
    const caught = await runGit(join(root!, 'repo'), ['fetch', 'origin']).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(caught).toBeInstanceOf(Error)
    expect(caught).toMatchObject({ code: 'SELF_DEV_WORKSPACE_GIT_FAILED' })
    const message = caught instanceof Error ? caught.message : String(caught)
    expect(message).toContain('https://example.invalid/repo.git/')
    expect(message).not.toContain('s3cr3t')
    expect(message).not.toContain('ci-bot')
  })

  it('resolves an empty successful output to undefined', async () => {
    await makeShim('#!/bin/sh\nprintf ""\n')
    await mkdir(join(root!, 'repo'), { recursive: true })
    expect(await revParse(join(root!, 'repo'), 'HEAD')).toBeUndefined()
  })

  it('resolves an unknown revision to undefined', async () => {
    const repo = await makeRepo()
    expect(await revParse(repo, 'HEAD')).toMatch(/^[0-9a-f]{40}$/)
    expect(await revParse(repo, 'no-such-ref')).toBeUndefined()
  })

  it('answers ancestor questions', async () => {
    const repo = await makeRepo()
    const head = (await revParse(repo, 'HEAD'))!
    const headParent = (await revParse(repo, 'HEAD~1'))!
    expect(await isAncestor(repo, headParent, head)).toBe(true)
    expect(await isAncestor(repo, head, headParent)).toBe(false)
    expect(await isAncestor(repo, 'no-such-ref', head)).toBe(false)
  })
})
