/** Acceptance definition validation and durable write under the control directory. */

import { mkdir, open, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { AcceptanceAssertion, AcceptanceCase, AcceptanceDefinition, RequiredCaseInput } from './types.ts'

/** Directory mode of `<controlDirectory>/acceptance/`. */
const ACCEPTANCE_DIR_MODE = 0o700
/** File mode of one acceptance definition file. */
const ACCEPTANCE_FILE_MODE = 0o600

/** Known assertion kinds with the field each kind requires. */
const ASSERTION_FIELDS: Record<string, readonly string[]> = {
  'exit-code': ['expected'],
  'stdout-includes': ['text'],
  'file-exists': ['path'],
  'file-includes': ['path', 'text'],
}

/**
 * One-line reference to every assertion kind's exact shape, shared verbatim
 * between the tool parameter description (`index.ts`) and every assertion
 * validation error below. A field test found a model guessing a wrong field
 * name (`value` instead of `expected`) and getting back only the one
 * violated rule, not the other kinds' shapes, so it could not self-correct
 * in one retry. Keeping one string used in both places also means the
 * schema the model sees and the error it can hit never drift apart.
 */
export const ASSERTION_SHAPE_REFERENCE =
  'assertion shapes: exit-code needs { assertionId, kind: "exit-code", expected (integer) }; '
  + 'stdout-includes needs { assertionId, kind: "stdout-includes", text (string) }; '
  + 'file-exists needs { assertionId, kind: "file-exists", path (string) }; '
  + 'file-includes needs { assertionId, kind: "file-includes", path (string), text (string) }.'

/**
 * Validate one drafted acceptance definition against the runner's acceptance schema.
 * @param value - the JSON value the tool received as `acceptance`: an object,
 *   or a JSON-encoded string of the same shape. The harness has been observed
 *   delivering a `type: 'json'`-declared parameter as a string rather than an
 *   already-parsed object, so both forms are accepted here regardless of what
 *   the tool's declared parameter schema accepts.
 * @returns the validated definition.
 * @throws Error naming the first violated rule, mirroring the runner's `SELF_DEV_RUNNER_ACCEPTANCE_INVALID` wording.
 */
export function parseAcceptanceDefinition(value: unknown): AcceptanceDefinition {
  const parsed = typeof value === 'string' ? parseAcceptanceJson(value) : value
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('acceptance definition must be an object with a cases array')
  }
  const candidate = parsed as Record<string, unknown>
  if (!Array.isArray(candidate.cases) || candidate.cases.length === 0) {
    throw new Error('acceptance definition must be an object with a cases array')
  }
  const cases = candidate.cases.map(parseCase)
  if (new Set(cases.map(acceptanceCase => acceptanceCase.caseId)).size !== cases.length) {
    throw new Error('acceptance definition defines a case more than once')
  }
  return { cases }
}

/** Parse one JSON-encoded acceptance definition string; see {@link parseAcceptanceDefinition}. */
function parseAcceptanceJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch (error) {
    throw new Error(`acceptance definition string is not valid JSON: ${(error as Error).message}`)
  }
}

/**
 * Check that the drafted plan's required cases are all defined by the acceptance
 * definition, including every assertion the plan names. The runner re-checks
 * this against the written file; checking here fails the proposal before any
 * campaign round is spent.
 * @param definition - the validated acceptance definition.
 * @param requiredCases - the plan's required cases.
 * @throws Error naming the first missing case or assertion.
 */
export function assertPlanCoveredByDefinition(definition: AcceptanceDefinition, requiredCases: readonly RequiredCaseInput[]): void {
  const byId = new Map(definition.cases.map(acceptanceCase => [acceptanceCase.caseId, acceptanceCase]))
  for (const required of requiredCases) {
    const acceptanceCase = byId.get(required.caseId)
    if (acceptanceCase === undefined) {
      throw new Error(`acceptance definition does not define required case ${required.caseId}`)
    }
    const assertionIds = new Set(acceptanceCase.assertions.map(assertion => assertion.assertionId))
    for (const assertionId of required.assertionIds) {
      if (!assertionIds.has(assertionId)) {
        throw new Error(`acceptance case ${required.caseId} does not define required assertion ${assertionId}`)
      }
    }
  }
}

/** Validate one acceptance case; see {@link parseAcceptanceDefinition}. */
function parseCase(value: unknown): AcceptanceCase {
  if (typeof value !== 'object' || value === null) {
    throw new Error('acceptance case must be an object')
  }
  const candidate = value as Record<string, unknown>
  if (typeof candidate.caseId !== 'string' || candidate.caseId === '') {
    throw new Error('acceptance case caseId must be a non-empty string')
  }
  if (!Array.isArray(candidate.command) || candidate.command.length === 0 || candidate.command.some(part => typeof part !== 'string')) {
    throw new Error('acceptance case command must be a non-empty array of strings')
  }
  if (typeof candidate.timeoutMs !== 'number' || !Number.isInteger(candidate.timeoutMs) || candidate.timeoutMs <= 0) {
    throw new Error('acceptance case timeoutMs must be a positive integer')
  }
  if (candidate.cwd !== undefined && typeof candidate.cwd !== 'string') {
    throw new Error('acceptance case cwd must be a string when present')
  }
  if (!Array.isArray(candidate.assertions) || candidate.assertions.length === 0) {
    throw new Error('acceptance case assertions must be a non-empty array')
  }
  const assertions = candidate.assertions.map(parseAssertion)
  if (new Set(assertions.map(assertion => assertion.assertionId)).size !== assertions.length) {
    throw new Error('acceptance case assertionId must be unique within a case')
  }
  return {
    caseId: candidate.caseId,
    command: candidate.command,
    ...(candidate.cwd === undefined ? {} : { cwd: candidate.cwd }),
    timeoutMs: candidate.timeoutMs,
    assertions,
  }
}

/** Validate one acceptance assertion; see {@link parseAcceptanceDefinition}. */
function parseAssertion(value: unknown): AcceptanceAssertion {
  if (typeof value !== 'object' || value === null) {
    throw new Error('acceptance assertion must be an object')
  }
  const candidate = value as Record<string, unknown>
  if (typeof candidate.assertionId !== 'string' || candidate.assertionId === '') {
    throw new Error('acceptance assertion assertionId must be a non-empty string')
  }
  const fields = ASSERTION_FIELDS[candidate.kind as string]
  if (fields === undefined) {
    throw new Error(`acceptance assertion kind ${JSON.stringify(candidate.kind ?? null)} is unknown; ${ASSERTION_SHAPE_REFERENCE}`)
  }
  for (const field of fields) {
    const expected = candidate[field]
    const valid = field === 'expected' ? typeof expected === 'number' && Number.isInteger(expected) : typeof expected === 'string' && expected !== ''
    if (!valid) {
      throw new Error(`acceptance assertion of kind ${String(candidate.kind)} needs a valid ${field}; ${ASSERTION_SHAPE_REFERENCE}`)
    }
  }
  return candidate as unknown as AcceptanceAssertion
}

/**
 * The acceptance definition path for one task, without writing anything.
 * @param controlDirectory - the stable-side control directory.
 * @param taskId - the task the definition belongs to.
 * @returns the absolute path {@link writeAcceptanceDefinition} writes to.
 */
export function acceptancePath(controlDirectory: string, taskId: string): string {
  return join(controlDirectory, 'acceptance', `${taskId}.json`)
}

/**
 * Write the acceptance definition to {@link acceptancePath}.
 * The directory is created with mode 0700 and the file is written atomically
 * (temporary file, then rename) with mode 0600, matching the control
 * directory's other host-written records.
 * @param controlDirectory - the stable-side control directory.
 * @param taskId - the task the definition belongs to.
 * @param definition - the validated definition.
 * @returns the absolute path the definition was written to.
 */
export async function writeAcceptanceDefinition(
  controlDirectory: string,
  taskId: string,
  definition: AcceptanceDefinition,
): Promise<string> {
  const directory = join(controlDirectory, 'acceptance')
  await mkdir(directory, { recursive: true, mode: ACCEPTANCE_DIR_MODE })
  const path = acceptancePath(controlDirectory, taskId)
  const temporary = `${path}.tmp`
  const body = `${JSON.stringify(definition, null, 2)}\n`
  const handle = await open(temporary, 'w', ACCEPTANCE_FILE_MODE)
  try {
    // The 0600 mode comes from the open() call; writeFile has no mode option.
    await handle.writeFile(body, 'utf8')
  } finally {
    await handle.close()
  }
  await rename(temporary, path)
  return path
}

/**
 * Whether a directory already exists — the existence check for the
 * pre-allocated workspace fallback when no workspaces service is mounted.
 * @param path - absolute directory path.
 * @returns `true` when the path exists as a directory.
 */
export async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
