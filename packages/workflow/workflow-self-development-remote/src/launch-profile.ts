/**
 * Per-task launch profile storage: one JSON file per task under the control
 * directory's `launch-profiles` subdirectory. A launch profile is per-task
 * deployment configuration, not task state: the core journal never records
 * it, the facade is its only writer, and reads validate the stored shape
 * before any launch derives an omitted field from it.
 * @module @deepseek-ai/dsh-workflow-self-development-remote/launch-profile
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { SelfDevelopmentRemoteError } from './errors.ts'
import { parseStoredLaunchProfile } from './schema.ts'
import type { LaunchProfile, LaunchProfileInput } from './types.ts'

/** Directory mode the facade creates the launch-profiles directory with. */
const DIRECTORY_MODE = 0o700

/** File mode every stored profile is written with. */
const FILE_MODE = 0o600

/**
 * The file path of one task's launch profile.
 * @param controlDirectory - the facade's configured control directory.
 * @param taskId - task identity naming the file.
 * @returns the absolute path `<controlDirectory>/launch-profiles/<taskId>.json`.
 */
export function launchProfilePath(controlDirectory: string, taskId: string): string {
  return join(controlDirectory, 'launch-profiles', `${taskId}.json`)
}

/**
 * Fill the derived fields of one host-supplied launch profile input.
 * `artifactPaths` derives from the task's `allowedModificationScope`,
 * `confirmedBy` from a sole `allowedActors` entry, and `loopbackAllowlist`
 * from `[]`.
 * @param input - the host's profile in wire form.
 * @param spec - the task's spec supplying the `allowedModificationScope` default; `undefined` when
 *   the task has no spec yet.
 * @param allowedActors - the facade's configured actor allowlist.
 * @param updatedAt - trusted-clock observation stamping the resolved profile.
 * @returns the resolved profile ready to store.
 * @throws SelfDevelopmentRemoteError with `self-development/config-invalid` when `artifactPaths` is
 *   absent and the task has no spec, or when `confirmedBy` is absent and `allowedActors` does not
 *   name exactly one actor.
 */
export function resolveLaunchProfile(
  input: LaunchProfileInput,
  spec: { readonly allowedModificationScope: readonly string[] } | undefined,
  allowedActors: readonly string[],
  updatedAt: number,
): LaunchProfile {
  const artifactPaths = input.artifactPaths ?? spec?.allowedModificationScope
  if (artifactPaths === undefined) {
    throw new SelfDevelopmentRemoteError(
      'self-development/config-invalid',
      'launchProfile.artifactPaths is missing and the task has no spec to derive it from',
    )
  }
  const confirmedBy = input.confirmedBy ?? (allowedActors.length === 1 ? allowedActors[0] : undefined)
  if (confirmedBy === undefined) {
    throw new SelfDevelopmentRemoteError(
      'self-development/config-invalid',
      'launchProfile.confirmedBy is missing and allowedActors does not name exactly one actor',
    )
  }
  return {
    worktree: input.worktree,
    acceptancePath: input.acceptancePath,
    artifactPaths,
    loopbackAllowlist: input.loopbackAllowlist ?? [],
    confirmedBy,
    updatedAt,
    ...(input.dataHome === undefined ? {} : { dataHome: input.dataHome }),
  }
}

/**
 * Read one task's stored launch profile.
 * @param controlDirectory - the facade's configured control directory.
 * @param taskId - task identity naming the file.
 * @returns the stored profile, or `undefined` when the task has none.
 * @throws SelfDevelopmentRemoteError with `self-development/config-invalid` when the file exists but
 *   is not valid JSON or fails the stored shape validation; the message names the file path,
 *   never its content.
 * @throws whatever the filesystem rejects with other than a missing file, so an unreadable profile
 *   never silently degrades a launch.
 */
export async function readLaunchProfile(controlDirectory: string, taskId: string): Promise<LaunchProfile | undefined> {
  const path = launchProfilePath(controlDirectory, taskId)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // JSON.parse failure messages can quote the file's bytes, so the refusal
    // names only the path.
    throw new SelfDevelopmentRemoteError('self-development/config-invalid', `launch profile ${path} is not valid JSON`)
  }
  return parseStoredLaunchProfile(path, parsed)
}

/**
 * Store one resolved launch profile atomically: the bytes land in a fresh
 * 0600 temporary file inside the profile directory and rename over the
 * target, so a reader never observes a partial profile.
 * @param controlDirectory - the facade's configured control directory.
 * @param taskId - task identity naming the file.
 * @param profile - the resolved profile to store.
 * @throws whatever the filesystem rejects with; the caller converts it at the facade boundary.
 */
export async function writeLaunchProfile(
  controlDirectory: string,
  taskId: string,
  profile: LaunchProfile,
): Promise<void> {
  const directory = join(controlDirectory, 'launch-profiles')
  await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE })
  const temporary = join(directory, `${taskId}.json.${randomUUID()}.tmp`)
  await writeFile(temporary, `${JSON.stringify(profile, null, 2)}\n`, { mode: FILE_MODE })
  await rename(temporary, launchProfilePath(controlDirectory, taskId))
}
