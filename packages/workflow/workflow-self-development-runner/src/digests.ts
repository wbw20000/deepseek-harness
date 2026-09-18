/**
 * Source and artifact digests for experiment worktrees. The source digest
 * freezes HEAD, the full working diff against HEAD, and every untracked
 * (non-ignored) file; the artifact digest freezes the bytes under explicit
 * worktree-relative paths. A symlink never contributes its target's bytes
 * read through an outside path: untracked links must stay inside the worktree
 * and are recorded by their link target, and artifact links — including links
 * found recursively — are recorded as `symlink:<target>` without being
 * followed. An artifact path that reaches outside through a symlinked
 * ancestor is refused instead of digested. Both digests are sha-256 over the
 * canonical JSON payload the task-control package's `digestJson` produces.
 * @module @deepseek-ai/dsh-workflow-self-development-runner/digests
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, readlink, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, posix, relative, resolve } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { digestJson } from '@deepseek-ai/dsh-workflow-self-development'
import { isInsideReal, realpathIfInside, staysInside } from './path-containment.ts'
import { SelfDevelopmentRunnerError } from './runtime.ts'
import type { ArtifactDigest, SourceDigest } from './types.ts'

/** Upper bound on one git command's captured output; past it the command fails instead of digesting a truncation. */
const GIT_MAX_BUFFER_BYTES = 1 << 26

/** Wall-clock bound on one git command so a hung git fails the digest instead of hanging the attempt. */
const GIT_TIMEOUT_MS = 30_000

/** sha-256 hex digest of arbitrary bytes. */
function sha256Bytes(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

/** sha-256 hex digest of a UTF-8 string. */
function sha256Text(text: string): string {
  return sha256Bytes(Buffer.from(text, 'utf8'))
}

/**
 * Run one git command inside the worktree.
 * @param worktree - directory the command runs in.
 * @param args - git arguments after the `-C <worktree>` pair.
 * @returns the command's stdout.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_WORKTREE_INVALID` when the process errors
 *   (including `ENOBUFS` on output overflow and `ETIMEDOUT`/timeout kills), never exits, or exits
 *   non-zero; the message carries the git subcommand and the failure reason.
 */
function runGit(worktree: string, args: readonly string[]): Buffer {
  const result = spawnSync('git', ['-C', worktree, ...args], {
    maxBuffer: GIT_MAX_BUFFER_BYTES,
    timeout: GIT_TIMEOUT_MS,
  })
  if (result.error !== undefined || result.status !== 0) {
    const reason = result.error !== undefined
      ? result.error.message
      : result.status === null
        ? 'timed out or could not start'
        : result.stderr.toString('utf8').trim() || `exit status ${String(result.status)}`
    throw new SelfDevelopmentRunnerError(
      `git ${args.join(' ')} in ${worktree} failed: ${reason}`,
      'SELF_DEV_RUNNER_WORKTREE_INVALID',
    )
  }
  return result.stdout
}

/**
 * Read one untracked worktree entry without following a symlink out of the worktree.
 * @param worktree - absolute path of the experiment worktree.
 * @param relativePath - worktree-relative path as reported by `git ls-files --others`.
 * @returns the entry's bytes; a plain file is read directly, a symlink through its
 *   worktree-internal target.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_WORKTREE_INVALID` when the entry
 *   vanished since the `ls-files` listing or is a symlink resolving outside the worktree.
 */
async function readUntrackedFile(worktree: string, relativePath: string): Promise<Buffer> {
  const target = join(worktree, relativePath)
  if (await realpathIfInside(worktree, dirname(target)) === undefined) {
    throw new SelfDevelopmentRunnerError(`untracked file ${relativePath} has an invalid parent`, 'SELF_DEV_RUNNER_WORKTREE_INVALID')
  }
  const info = await lstat(target).catch(() => undefined)
  if (info !== undefined && !info.isSymbolicLink()) {
    if (!info.isFile()) throw new SelfDevelopmentRunnerError(`untracked entry ${relativePath} is not a regular file`, 'SELF_DEV_RUNNER_WORKTREE_INVALID')
    // The `ls-files` listing can be stale: a file deleted after the listing
    // but before this read is a worktree-state failure, not a crash.
    return readFile(target).catch((error: unknown) => {
      throw new SelfDevelopmentRunnerError(
        `untracked file ${relativePath} could not be read from the worktree ${worktree}: ${String(error)}`,
        'SELF_DEV_RUNNER_WORKTREE_INVALID',
      )
    })
  }
  // A vanished entry or a symlink: resolve the link target and refuse to read
  // anything that left the worktree; lstat never follows the link itself. Both
  // paths resolve through the filesystem, so a symlinked worktree root compares
  // equal to its resolved entries.
  const resolved = await realpath(target).catch(() => undefined)
  if (resolved === undefined) {
    throw new SelfDevelopmentRunnerError(
      `untracked file ${relativePath} is missing from the worktree ${worktree}`,
      'SELF_DEV_RUNNER_WORKTREE_INVALID',
    )
  }
  if (!isInsideReal(await realpath(worktree), resolved)) {
    throw new SelfDevelopmentRunnerError(
      `untracked file ${relativePath} points outside the worktree ${worktree}`,
      'SELF_DEV_RUNNER_WORKTREE_INVALID',
    )
  }
  if (!(await lstat(resolved)).isFile()) throw new SelfDevelopmentRunnerError(`untracked link ${relativePath} does not resolve to a regular file`, 'SELF_DEV_RUNNER_WORKTREE_INVALID')
  return readFile(resolved)
}

/**
 * Digest an experiment worktree's source state: HEAD commit, the binary diff
 * against HEAD, and every untracked non-ignored file.
 * @param worktree - absolute path of the experiment worktree.
 * @returns the branded sha-256 digest of the canonical source payload.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_WORKTREE_INVALID` when the directory is
 *   not a git worktree with at least one commit, a git command fails, times out, or overflows its
 *   output buffer, or an untracked entry is missing or a symlink leaving the worktree.
 */
export async function sourceDigestOf(worktree: string): Promise<SourceDigest> {
  const head = runGit(worktree, ['rev-parse', 'HEAD'])
  const diff = runGit(worktree, ['diff', 'HEAD', '--binary'])
  const untracked = runGit(worktree, ['ls-files', '--others', '--exclude-standard', '-z'])
  const untrackedPaths = untracked.toString('utf8').split('\0').filter(Boolean).sort()
  const untrackedEntries: [string, string, string | null][] = []
  for (const path of untrackedPaths) {
    try {
      const content = await readUntrackedFile(worktree, path)
      const info = await lstat(join(worktree, path))
      untrackedEntries.push([path, sha256Bytes(content), info.isSymbolicLink() ? await readlink(join(worktree, path)) : null])
    } catch (error) {
      if (error instanceof SelfDevelopmentRunnerError) throw error
      throw new SelfDevelopmentRunnerError(`untracked entry ${path} could not be read: ${String(error)}`, 'SELF_DEV_RUNNER_WORKTREE_INVALID')
    }
  }
  return brandString<SourceDigest>(sha256Text(digestJson({
    head: head.toString('utf8').trim(),
    diff: sha256Bytes(diff),
    untracked: untrackedEntries,
  })))
}

/**
 * Resolve one requested artifact path to the normalized worktree-relative path
 * used in the digest, refusing every spelling that leaves the worktree.
 * @param worktree - absolute path of the experiment worktree.
 * @param requested - caller-supplied worktree-relative artifact path.
 * @returns the normalized relative path; `./dist` and `dist` resolve identically,
 *   as do `tracked.txt` and its trailing-slash spelling.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_WORKTREE_INVALID` when the path is
 *   absolute, empty (`.`), or escapes the worktree through `..`.
 */
function resolveArtifactPath(worktree: string, requested: string): string {
  // A trailing slash is not part of an entry name: `tracked.txt/` names the
  // file `tracked.txt`, so both spellings must reach the same digest entry.
  const normalized = posix.normalize(requested).replace(/\/+$/, '')
  const inside = relative(worktree, resolve(worktree, normalized))
  if (isAbsolute(normalized) || inside === '' || !isInsideReal(worktree, resolve(worktree, normalized))) {
    throw new SelfDevelopmentRunnerError(
      `artifact path ${JSON.stringify(requested)} must stay inside the worktree ${worktree}`,
      'SELF_DEV_RUNNER_WORKTREE_INVALID',
    )
  }
  return normalized
}

/**
 * Digest the bytes under explicit worktree-relative artifact paths. A path
 * may name a file or a directory (digested recursively); a missing path is
 * recorded as `[path, 'absent']` instead of failing, so a failed build
 * produces a stable digest that differs from every present artifact set. A
 * symlink records its link text without following it, so a link
 * cannot pull worktree-external bytes into the digest.
 * @param worktree - absolute path of the experiment worktree.
 * @param paths - worktree-relative artifact paths, files or directories.
 * @returns the branded sha-256 digest of the sorted `[path, hash]` list.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_WORKTREE_INVALID` when a path is
 *   absolute or escapes the worktree through `..`.
 */
export async function artifactDigestOf(worktree: string, paths: readonly string[]): Promise<ArtifactDigest> {
  const entries: [string, string][] = []
  for (const requested of paths) {
    const path = resolveArtifactPath(worktree, requested)
    const target = join(worktree, path)
    if (!(await staysInside(worktree, dirname(target)))) {
      throw new SelfDevelopmentRunnerError(`artifact path ${path} has a parent outside the worktree`, 'SELF_DEV_RUNNER_WORKTREE_INVALID')
    }
    const info = await lstat(target).catch((error: unknown) => {
      if (typeof error === 'object' && error !== null && 'code' in error
        && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return undefined
      throw new SelfDevelopmentRunnerError(`artifact path ${path} cannot be inspected: ${String(error)}`, 'SELF_DEV_RUNNER_WORKTREE_INVALID')
    })
    if (info === undefined) {
      entries.push([path, 'absent'])
    } else if (info.isSymbolicLink()) {
      entries.push([path, `symlink:${await readlink(target)}`])
    } else if (info.isDirectory()) {
      entries.push(...await collectDirectory(worktree, path))
    } else if (info.isFile()) {
      entries.push([path, sha256Bytes(await readFile(target))])
    } else {
      throw new SelfDevelopmentRunnerError(`artifact path ${path} is not a regular file or directory`, 'SELF_DEV_RUNNER_WORKTREE_INVALID')
    }
  }
  const order = (left: readonly [string, string], right: readonly [string, string]): -1 | 1 =>
    // Paths are unique across the collected entries, so a strict total order suffices.
    left[0] < right[0] ? -1 : 1
  entries.sort(order)
  return brandString<ArtifactDigest>(sha256Text(digestJson(entries)))
}

/**
 * Collect `[relativePath, sha256]` entries for every file under one
 * worktree-relative directory, depth-first in sorted order. A symlink is
 * recorded with its link text without following it, so a link
 * cannot pull worktree-external bytes into the digest.
 * @param worktree - absolute path of the experiment worktree.
 * @param directory - worktree-relative directory path.
 * @returns the sorted file entries; an empty directory contributes nothing.
 */
async function collectDirectory(worktree: string, directory: string): Promise<[string, string][]> {
  const entries: [string, string][] = []
  const names = (await readdir(join(worktree, directory))).sort()
  for (const name of names) {
    const relativePath = join(directory, name)
    const target = join(worktree, relativePath)
    const info = await lstat(target)
    if (info.isSymbolicLink()) {
      entries.push([relativePath, `symlink:${await readlink(target)}`])
    } else if (info.isDirectory()) {
      entries.push(...await collectDirectory(worktree, relativePath))
    } else if (info.isFile()) {
      entries.push([relativePath, sha256Bytes(await readFile(target))])
    } else {
      throw new SelfDevelopmentRunnerError(`artifact path ${relativePath} is not a regular file or directory`, 'SELF_DEV_RUNNER_WORKTREE_INVALID')
    }
  }
  return entries
}
