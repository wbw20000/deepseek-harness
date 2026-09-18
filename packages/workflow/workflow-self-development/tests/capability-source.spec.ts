/**
 * Capability evidence source tests: the two named source kinds, the bumped
 * journal schema, per-item source validation, the attempt's recorded
 * aggregate source, and refusal of older journal schema versions.
 * @module capability-source
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CAPABILITY_SOURCE_KINDS, TASK_JOURNAL_SCHEMA_VERSION, CapabilityDigest } from '../src/runtime.ts'
import { TaskJournal } from '../src/journal.ts'
import { ARTIFACT, SOURCE, fullCapabilitySource, header, makeTaskDir, openReadyTask, passingResult } from './helpers.ts'
import type { Attempt, CapabilitySource } from '../src/types.ts'

/** Last journal record parsed from disk. */
interface StoredRecord { event: { type: string; attempt?: Attempt } }

/** Parse every journal record from one segment. */
function records(text: string): StoredRecord[] {
  return text.trim().split('\n').map(line => JSON.parse(line) as StoredRecord)
}

/** Evidence items with the `source` field stripped, as an old provider would report. */
const sourcelessEvidence: CapabilitySource = {
  evidence: names => names.map(capability => ({ capability, digest: CapabilityDigest('d'.repeat(64)) })) as never,
}

/** Evidence items carrying a source outside the known kinds. */
const unknownSourceEvidence: CapabilitySource = {
  evidence: names => names.map(capability => ({ capability, source: 'oracle', digest: CapabilityDigest('d'.repeat(64)) })) as never,
}

describe('capability source kinds', () => {
  it('names exactly the two kinds and bumps the journal schema', () => {
    expect([...CAPABILITY_SOURCE_KINDS]).toEqual(['human-presence', 'machine'])
    expect(TASK_JOURNAL_SCHEMA_VERSION).toBe(2)
  })

  it('refuses evidence that declares no valid source', async () => {
    const { dir, clock } = await makeTaskDir()
    const { controller, revision } = await openReadyTask(dir, clock, undefined, sourcelessEvidence)
    await expect(controller.startAttempt({
      ...header(revision, 'attempt-sourceless'),
      sourceDigest: SOURCE,
      artifactDigest: ARTIFACT,
      sideEffect: async () => { throw new Error('side effect must not run') },
    })).rejects.toMatchObject({
      code: 'SELF_DEV_CAPABILITY_MISSING',
      message: 'capability evidence for supervisor has no valid source',
    })
    expect(controller.projection.status).toBe('ready')
  })

  it('refuses evidence whose source is outside the known kinds', async () => {
    const { dir, clock } = await makeTaskDir()
    const { controller, revision } = await openReadyTask(dir, clock, undefined, unknownSourceEvidence)
    await expect(controller.startAttempt({
      ...header(revision, 'attempt-unknown-source'),
      sourceDigest: SOURCE,
      artifactDigest: ARTIFACT,
      sideEffect: async () => { throw new Error('side effect must not run') },
    })).rejects.toMatchObject({ code: 'SELF_DEV_CAPABILITY_MISSING' })
  })

  it('records human presence on the attempt when any item is human-presence evidence', async () => {
    const { dir, clock } = await makeTaskDir()
    const humanSource: CapabilitySource = {
      evidence: names => names.map(capability => ({
        capability,
        source: capability === 'supervisor' ? ('human-presence' as const) : ('machine' as const),
        digest: CapabilityDigest('d'.repeat(64)),
      })),
    }
    const { controller, revision } = await openReadyTask(dir, clock, undefined, humanSource)
    let observed: Attempt | undefined
    await controller.startAttempt({
      ...header(revision, 'attempt-human'),
      sourceDigest: SOURCE,
      artifactDigest: ARTIFACT,
      sideEffect: async (attempt) => {
        observed = attempt
        // The projection path carries the source while the attempt is active.
        expect(controller.projection.currentAttempt?.capabilitySource).toBe('human-presence')
        return passingResult(attempt)
      },
    })
    expect(observed?.capabilitySource).toBe('human-presence')
    const line = await readFile(join(dir, 'events.00000001.jsonl'), 'utf8')
    const started = records(line).find(record => record.event.type === 'attempt/started')
    expect(started?.event.attempt?.capabilitySource).toBe('human-presence')
  })

  it('records machine when every item is machine evidence', async () => {
    const { dir, clock } = await makeTaskDir()
    const { controller, revision } = await openReadyTask(dir, clock, undefined, fullCapabilitySource)
    let observed: Attempt | undefined
    await controller.startAttempt({
      ...header(revision, 'attempt-machine'),
      sourceDigest: SOURCE,
      artifactDigest: ARTIFACT,
      sideEffect: async (attempt) => {
        observed = attempt
        return passingResult(attempt)
      },
    })
    expect(observed?.capabilitySource).toBe('machine')
  })

  it('refuses a journal written under schemaVersion 1 and raises handoff', async () => {
    const { dir } = await makeTaskDir()
    const journal = await TaskJournal.open(dir, { maxRecordsPerSegment: 64, checkpointInterval: 4 })
    await journal.append({ type: 'task/planning-authorized', authorizedBy: 'user' }, undefined)
    const stale = await readFile(join(dir, 'events.00000001.jsonl'), 'utf8')
    // Rewrite the current version marker so a future bump keeps this a v1 fixture instead of a no-op.
    const marker = `"schemaVersion":${TASK_JOURNAL_SCHEMA_VERSION}`
    expect(stale).toContain(marker)
    await writeFile(join(dir, 'events.00000001.jsonl'), stale.replace(marker, '"schemaVersion":1'))
    const options = { maxRecordsPerSegment: 64, checkpointInterval: 4 }
    const rejection = await TaskJournal.open(dir, options).then(() => null, (error: unknown) => error)
    expect((rejection as { code?: string }).code).toBe('SELF_DEV_JOURNAL_UNAVAILABLE')
    expect((rejection as { message?: string }).message).toMatch(/carries unknown schemaVersion/u)
  })
})
