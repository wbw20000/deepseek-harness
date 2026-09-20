/**
 * Unit behavior of the leaf modules: acceptance-definition parsing and its
 * durable write, task-id derivation and the baseline digest, budget
 * validation and wire mapping, the bilingual approval-card copy, and the
 * deployment-config resolution.
 * @module units.spec
 */

import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  acceptancePath,
  assertPlanCoveredByDefinition,
  directoryExists,
  parseAcceptanceDefinition,
  writeAcceptanceDefinition,
} from '../src/acceptance.ts'
import { deriveTaskId, readBaselineDigest, runGit } from '../src/baseline.ts'
import { budgetViolation, toBudgetApproval } from '../src/budget.ts'
import { approvalReason } from '../src/card.ts'
import { resolveChatConfig } from '../src/config.ts'
import type { ProposeBudget, ResolvedProposeInput } from '../src/types.ts'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** One acceptance case with a passing exit-code assertion. */
function caseWith(caseId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    caseId,
    command: ['node', '--version'],
    timeoutMs: 5000,
    assertions: [{ assertionId: `${caseId}-a1`, kind: 'exit-code', expected: 0 }],
    ...overrides,
  }
}

/** An acceptance definition with cases c1 and c2. */
function definitionWith(...cases: Record<string, unknown>[]): unknown {
  return { cases: cases.length > 0 ? cases : [caseWith('c1'), caseWith('c2')] }
}

describe('parseAcceptanceDefinition', () => {
  it('accepts a valid definition and keeps every case field', () => {
    const definition = parseAcceptanceDefinition(definitionWith(
      caseWith('c1', { cwd: 'sub', assertions: [
        { assertionId: 'a1', kind: 'exit-code', expected: 3 },
        { assertionId: 'a2', kind: 'stdout-includes', text: 'ready' },
        { assertionId: 'a3', kind: 'file-exists', path: 'out/log' },
        { assertionId: 'a4', kind: 'file-includes', path: 'out/log', text: 'done' },
      ] }),
    ))
    expect(definition.cases).toHaveLength(1)
    expect(definition.cases[0]?.cwd).toBe('sub')
    expect(definition.cases[0]?.assertions).toHaveLength(4)
  })

  it('rejects a non-object, an array, and an empty or missing cases array', () => {
    expect(() => parseAcceptanceDefinition(null)).toThrow('must be an object with a cases array')
    expect(() => parseAcceptanceDefinition([caseWith('c1')])).toThrow('must be an object with a cases array')
    expect(() => parseAcceptanceDefinition({ cases: [] })).toThrow('must be an object with a cases array')
    expect(() => parseAcceptanceDefinition({})).toThrow('must be an object with a cases array')
  })

  it('rejects a duplicate case id', () => {
    expect(() => parseAcceptanceDefinition(definitionWith(caseWith('c1'), caseWith('c1'))))
      .toThrow('defines a case more than once')
  })

  it('rejects invalid case fields', () => {
    expect(() => parseAcceptanceDefinition({ cases: ['not-an-object'] })).toThrow('case must be an object')
    expect(() => parseAcceptanceDefinition(definitionWith(caseWith('c1', { caseId: '' })))).toThrow('caseId')
    expect(() => parseAcceptanceDefinition(definitionWith({ timeoutMs: 1 }))).toThrow('caseId')
    expect(() => parseAcceptanceDefinition(definitionWith(caseWith('c1', { command: [] })))).toThrow('command')
    expect(() => parseAcceptanceDefinition(definitionWith(caseWith('c1', { command: ['node', 3] })))).toThrow('command')
    expect(() => parseAcceptanceDefinition(definitionWith(caseWith('c1', { timeoutMs: 0 })))).toThrow('timeoutMs')
    expect(() => parseAcceptanceDefinition(definitionWith(caseWith('c1', { timeoutMs: 1.5 })))).toThrow('timeoutMs')
    expect(() => parseAcceptanceDefinition(definitionWith(caseWith('c1', { timeoutMs: 'fast' })))).toThrow('timeoutMs')
    expect(() => parseAcceptanceDefinition(definitionWith(caseWith('c1', { cwd: 3 })))).toThrow('cwd')
    expect(() => parseAcceptanceDefinition(definitionWith(caseWith('c1', { assertions: [] })))).toThrow('assertions')
    const duplicateAssertionId = definitionWith(caseWith('c1', { assertions: [
      { assertionId: 'a1', kind: 'exit-code', expected: 0 },
      { assertionId: 'a1', kind: 'stdout-includes', text: 'ready' },
    ] }))
    expect(() => parseAcceptanceDefinition(duplicateAssertionId)).toThrow('assertionId must be unique')
  })

  it('rejects invalid assertions', () => {
    expect(() => parseAcceptanceDefinition(definitionWith(caseWith('c1', { assertions: ['not-an-object'] }))))
      .toThrow('assertion must be an object')
    const noAssertions = definitionWith(caseWith('c1', { assertions: [{}] }))
    expect(() => parseAcceptanceDefinition(noAssertions)).toThrow('assertionId')
    const unknownKind = definitionWith(caseWith('c1', { assertions: [{ assertionId: 'a1', kind: 'stdout-equals' }] }))
    expect(() => parseAcceptanceDefinition(unknownKind)).toThrow('unknown')
    const missingKind = definitionWith(caseWith('c1', { assertions: [{ assertionId: 'a1' }] }))
    expect(() => parseAcceptanceDefinition(missingKind)).toThrow('null')
    const badExitCode = definitionWith(caseWith('c1', { assertions: [{ assertionId: 'a1', kind: 'exit-code', expected: 1.5 }] }))
    expect(() => parseAcceptanceDefinition(badExitCode)).toThrow('expected')
    const badText = definitionWith(caseWith('c1', { assertions: [{ assertionId: 'a1', kind: 'stdout-includes', text: '' }] }))
    expect(() => parseAcceptanceDefinition(badText)).toThrow('text')
    const missingPath = definitionWith(caseWith('c1', { assertions: [{ assertionId: 'a1', kind: 'file-exists' }] }))
    expect(() => parseAcceptanceDefinition(missingPath)).toThrow('path')
    const missingInclude = definitionWith(caseWith('c1', { assertions: [{ assertionId: 'a1', kind: 'file-includes', path: 'p' }] }))
    expect(() => parseAcceptanceDefinition(missingInclude)).toThrow('text')
  })
})

describe('assertPlanCoveredByDefinition', () => {
  it('accepts a plan whose required cases and assertions are all defined', () => {
    const definition = parseAcceptanceDefinition(definitionWith())
    expect(() => {
      assertPlanCoveredByDefinition(definition, [
        { caseId: 'c1', requirement: 'r', assertionIds: ['c1-a1'] },
      ])
    }).not.toThrow()
  })

  it('rejects a missing case and a missing assertion', () => {
    const definition = parseAcceptanceDefinition(definitionWith())
    expect(() => {
      assertPlanCoveredByDefinition(definition, [
        { caseId: 'c9', requirement: 'r', assertionIds: [] },
      ])
    }).toThrow('does not define required case c9')
    expect(() => {
      assertPlanCoveredByDefinition(definition, [
        { caseId: 'c1', requirement: 'r', assertionIds: ['nope'] },
      ])
    }).toThrow('does not define required assertion nope')
  })
})

describe('writeAcceptanceDefinition', () => {
  it('writes the definition atomically with 0600 inside a 0700 directory', async () => {
    root = await mkdtemp(join(tmpdir(), 'self-dev-chat-acc-'))
    const control = join(root, 'control')
    const path = await writeAcceptanceDefinition(control, 'task-1', parseAcceptanceDefinition(definitionWith()))
    expect(path).toBe(acceptancePath(control, 'task-1'))
    const file = await stat(path)
    expect(file.mode & 0o777).toBe(0o600)
    const directory = await stat(join(control, 'acceptance'))
    expect(directory.mode & 0o777).toBe(0o700)
    expect(await directoryExists(path)).toBe(false)
    expect(await directoryExists(join(control, 'acceptance'))).toBe(true)
    expect(await directoryExists(join(control, 'missing'))).toBe(false)
    // A non-ENOENT stat failure propagates: a file used as a directory segment.
    await writeFile(join(control, 'blocker'), 'x')
    await expect(directoryExists(join(control, 'blocker', 'inner'))).rejects.toThrow()
  })
})

describe('deriveTaskId', () => {
  it('kebab-cases the first words and appends the suffix', () => {
    expect(deriveTaskId('给 CLI 加 --json 输出', 'a1b2c3')).toBe('cli-json-a1b2c3')
    expect(deriveTaskId('Add chat transcript search', 'deadbe')).toBe('add-chat-transcript-search-deadbe')
  })

  it('falls back to the task stem and to a random suffix', () => {
    expect(deriveTaskId('纯中文需求 -> ##', 'a1b2c3')).toBe('task-a1b2c3')
    expect(deriveTaskId('add search')).toMatch(/^add-search-[0-9a-f]{6}$/)
  })
})

describe('readBaselineDigest', () => {
  it('hashes the commit id the git runner prints', async () => {
    const digest = await readBaselineDigest('/repo', async () => 'abc123')
    expect(digest).toBe(createHash('sha256').update('abc123').digest('hex'))
  })

  it('rejects an empty commit id and surfaces git failures', async () => {
    await expect(readBaselineDigest('/repo', async () => '')).rejects.toThrow('printed no commit id')
    await expect(readBaselineDigest('/repo', async () => {
      throw new Error('fatal: not a git repository')
    })).rejects.toThrow('not a git repository')
  })

  it('runs git for real in a repository (the default runner)', async () => {
    const repoRoot = new URL('../../../', import.meta.url).pathname
    const digest = await readBaselineDigest(repoRoot)
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
    const raw = await runGit(['rev-parse', 'HEAD'], repoRoot)
    expect(raw).toMatch(/^[0-9a-f]{40}$/)
  })
})

describe('budgetViolation', () => {
  it('accepts the unlimited preset and rejects other presets', () => {
    expect(budgetViolation({ preset: 'unlimited' })).toBeUndefined()
    expect(budgetViolation({ preset: 'bounded' } as unknown as ProposeBudget)).toContain('preset')
  })

  it('enforces positive integer rounds', () => {
    expect(budgetViolation({ mode: 'rounds', maxRounds: 3 })).toBeUndefined()
    expect(budgetViolation({ mode: 'rounds', maxRounds: 0 })).toContain('maxRounds')
    expect(budgetViolation({ mode: 'rounds', maxRounds: 1.5 })).toContain('maxRounds')
    expect(budgetViolation({ mode: 'rounds', maxRounds: undefined as unknown as number })).toContain('maxRounds')
  })

  it('enforces the frozen 24-hour ceiling', () => {
    expect(budgetViolation({ mode: 'time', hours: 24 })).toBeUndefined()
    expect(budgetViolation({ mode: 'time', hours: 24.5 })).toContain('hours')
    expect(budgetViolation({ mode: 'time', hours: 0 })).toContain('hours')
    expect(budgetViolation({ mode: 'time', hours: Number.NaN })).toContain('hours')
    expect(budgetViolation({ mode: 'time', hours: undefined as unknown as number })).toContain('hours')
  })
})

describe('toBudgetApproval', () => {
  const base = { testPlanVersion: 1, taskSpecVersion: 1, approvedBy: 'user' }

  it('expands the unlimited preset with the preset marker and the time fields', () => {
    expect(toBudgetApproval({ preset: 'unlimited' }, base)).toEqual({
      preset: 'unlimited',
      mode: 'time',
      durationMs: 24 * 3600 * 1000,
      phaseTimeoutMs: 600_000,
      maxStepsPerAttempt: 40,
      noProgressAttemptLimit: 5,
      ...base,
    })
  })

  it('maps a rounds budget to the rounds wire form', () => {
    expect(toBudgetApproval({ mode: 'rounds', maxRounds: 3 }, base)).toEqual({
      mode: 'rounds',
      maxRounds: 3,
      phaseTimeoutMs: 600_000,
      maxStepsPerAttempt: 40,
      ...base,
    })
  })

  it('maps a time budget to the time wire form with the no-progress guard', () => {
    expect(toBudgetApproval({ mode: 'time', hours: 2 }, base)).toEqual({
      mode: 'time',
      durationMs: 2 * 3600 * 1000,
      noProgressAttemptLimit: 5,
      ...base,
    })
  })
})

describe('approvalReason', () => {
  const paths = { taskId: 'task-1', experimentsRoot: '/exp', acceptancePath: '/exp/control/acceptance/task-1.json' }

  it('renders every covered decision in English', () => {
    const input = {
      requirement: 'add search',
      allowedModificationScope: ['src/**'],
      plan: {
        requiredCases: [{ caseId: 'c1', requirement: 'r', assertionIds: ['a1'] }],
        manualCases: ['manual-review'],
      },
      acceptance: definitionWith(),
      budget: { preset: 'unlimited' },
      unattended: true,
      parallel: true,
    } as ResolvedProposeInput
    const reason = approvalReason(input, paths, 'en')
    expect(reason).toContain('Requirement: add search')
    expect(reason).toContain('Acceptance cases: c1; manual: manual-review')
    expect(reason).toContain('Budget: unlimited (time capped at 24h)')
    expect(reason).toContain('Unattended: yes — one approval covers every round, no OS isolation')
    expect(reason).toContain('Workspace: /exp (task task-1)')
    expect(reason).toContain('Acceptance definition: /exp/control/acceptance/task-1.json')
  })

  it('renders the supervised and non-unlimited variants in Chinese', () => {
    const input = {
      requirement: '加搜索',
      allowedModificationScope: ['src/**'],
      plan: {
        requiredCases: [{ caseId: 'c1', requirement: 'r', assertionIds: ['a1'] }],
        manualCases: [],
      },
      acceptance: definitionWith(),
      budget: { mode: 'rounds', maxRounds: 4 },
      unattended: false,
      parallel: false,
    } as ResolvedProposeInput
    const reason = approvalReason(input, paths, 'zh')
    expect(reason).toContain('需求：加搜索')
    expect(reason).not.toContain('人工核验')
    expect(reason).toContain('预算：轮数上限 4')
    expect(reason).toContain('无人值守：否——每轮再次确认')
    const timed = approvalReason({ ...input, budget: { mode: 'time', hours: 3 } }, paths, 'zh')
    expect(timed).toContain('预算：时间上限 3 小时')
  })

  it('renders the rounds and time budgets, the no-manual-cases join, and the not-unattended line in English', () => {
    const input = {
      requirement: 'add search',
      allowedModificationScope: ['src/**'],
      plan: {
        requiredCases: [{ caseId: 'c1', requirement: 'r', assertionIds: ['a1'] }],
        manualCases: [],
      },
      acceptance: definitionWith(),
      budget: { mode: 'rounds', maxRounds: 4 },
      unattended: false,
      parallel: false,
    } as ResolvedProposeInput
    const reason = approvalReason(input, paths, 'en')
    expect(reason).toContain('Acceptance cases: c1')
    expect(reason).not.toContain('manual:')
    expect(reason).toContain('Budget: max 4 rounds')
    expect(reason).toContain('Unattended: no — every round asks again')
    const timed = approvalReason({ ...input, budget: { mode: 'time', hours: 3 } }, paths, 'en')
    expect(timed).toContain('Budget: time capped at 3h')
  })
})

describe('resolveChatConfig', () => {
  const base = { stableRepo: '/repo', controlDirectory: '/repo/control', experimentsRoot: '/exp', actor: 'user' }

  it('applies the documented defaults', () => {
    const resolved = resolveChatConfig(base)
    expect(resolved.cardLocale).toBe('zh')
    expect(resolved.defaultUnattended).toBe(true)
    expect(resolved.defaultBudget).toEqual({ preset: 'unlimited' })
  })

  it('keeps explicit values', () => {
    const resolved = resolveChatConfig({ ...base, cardLocale: 'en', defaultUnattended: false, defaultBudget: { mode: 'rounds', maxRounds: 2 } })
    expect(resolved.cardLocale).toBe('en')
    expect(resolved.defaultUnattended).toBe(false)
    expect(resolved.defaultBudget).toEqual({ mode: 'rounds', maxRounds: 2 })
  })

  it('fails loud on invalid paths, actor, and locale', () => {
    expect(() => resolveChatConfig({ ...base, stableRepo: 'relative/path' })).toThrow('stableRepo must be an absolute path')
    expect(() => resolveChatConfig({ ...base, controlDirectory: '' })).toThrow('controlDirectory')
    expect(() => resolveChatConfig({ ...base, experimentsRoot: undefined as unknown as string })).toThrow('experimentsRoot')
    expect(() => resolveChatConfig({ ...base, actor: '' })).toThrow('actor')
    expect(() => resolveChatConfig({ ...base, actor: 3 as unknown as string })).toThrow('actor')
    expect(() => resolveChatConfig({ ...base, cardLocale: 'fr' as unknown as 'zh' | 'en' })).toThrow('cardLocale')
  })
})
