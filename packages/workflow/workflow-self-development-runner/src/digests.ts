/**
 * Source and artifact digests for experiment worktrees. The source digest
 * freezes HEAD, the full working diff against HEAD, and every untracked
 * (non-ignored) file; the artifact digest freezes the bytes under explicit
 * worktree-relative paths. Both are sha-256 over the canonical JSON payload
 * the task-control package's `digestJson` produces.
 * @module @deepseek-ai/dsh-workflow-self-development-runner/digests
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { digestJson } from '@deepseek-ai/dsh-workflow-self-development'
import { SelfDevelopmentRunnerError } from './runtime.ts'
import type { ArtifactDigest, SourceDigest } from './types.ts'

/** sha-256 hex digest of arbitrary bytes. */
function sha256Bytes(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

/** sha-256 hex digest of a UTF-8 string. */
function sha256Text(text: string): string {
  return sha256Bytes(Buffer.from(text, 'utf8'))
}

/** One git command's classified process result. */
interface GitResult {
  readonly status: number | null
  readonly stdout: Buffer
  readonly stderr: Buffer
}

/**
 * Run one git command inside the worktree.
 * @param worktree - directory the command runs in.
 * @param args - git arguments after the `-C <worktree>` pair.
 * @returns the raw process result for the caller to classify.
 */
function runGit(worktree: string, args: readonly string[]): GitResult {
  return spawnSync('git', ['-C', worktree, ...args], { maxBuffer: 1 << 26 })
}

/**
 * Digest an experiment worktree's source state: HEAD commit, the binary diff
 * against HEAD, and every untracked non-ignored file.
 * @param worktree - absolute path of the experiment worktree.
 * @returns the branded sha-256 digest of the canonical source payload.
 * @throws SelfDevelopmentRunnerError with `SELF_DEV_RUNNER_WORKTREE_INVALID` when the directory is
 *   not a git worktree with at least one commit.
 */
export async function sourceDigestOf(worktree: string): Promise<SourceDigest> {
  const head = runGit(worktree, ['rev-parse', 'HEAD'])
  if (head.status !== 0) {
    throw new SelfDevelopmentRunnerError(
      `${worktree} is not a git worktree with a commit: ${head.stderr.toString('utf8').trim()}`,
      'SELF_DEV_RUNNER_WORKTREE_INVALID',
    )
  }
  const diff = runGit(worktree, ['diff', 'HEAD', '--binary'])
  const untracked = runGit(worktree, ['ls-files', '--others', '--exclude-standard', '-z'])
  const untrackedPaths = untracked.stdout.toString('utf8').split('\0').filter(Boolean).sort()
  const untrackedEntries: [string, string][] = []
  for (const path of untrackedPaths) {
    untrackedEntries.push([path, sha256Bytes(await readFile(join(worktree, path)))])
  }
  return brandString<SourceDigest>(sha256Text(digestJson({
    head: head.stdout.toString('utf8').trim(),
    diff: sha256Bytes(diff.stdout),
    untracked: untrackedEntries,
  })))
}

/**
 * Digest the bytes under explicit worktree-relative artifact paths. A path
 * may name a file or a directory (digested recursively); a missing path is
 * recorded as `[path, 'absent']` instead of failing, so a failed build
 * produces a stable digest that differs from every present artifact set.
 * @param worktree - absolute path of the experiment worktree.
 * @param paths - worktree-relative artifact paths, files or directories.
 * @returns the branded sha-256 digest of the sorted `[path, hash]` list.
 */
export async function artifactDigestOf(worktree: string, paths: readonly string[]): Promise<ArtifactDigest> {
  const entries: [string, string][] = []
  for (const path of paths) {
    const target = join(worktree, path)
    const info = await stat(target).catch(() => undefined)
    if (info === undefined) {
      entries.push([path, 'absent'])
    } else if (info.isDirectory()) {
      entries.push(...await collectDirectory(worktree, path))
    } else {
      entries.push([path, sha256Bytes(await readFile(target))])
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
 * worktree-relative directory, depth-first in sorted order.
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
    if ((await stat(target)).isDirectory()) {
      entries.push(...await collectDirectory(worktree, relativePath))
    } else {
      entries.push([relativePath, sha256Bytes(await readFile(target))])
    }
  }
  return entries
}
