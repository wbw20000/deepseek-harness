/**
 * `verifyAcceptance` behavior against a real temporary worktree and a real
 * acceptance definition: a passing case resolves `ok: true` with the observed
 * report — with and without a configured overall `phaseTimeoutMs` — and a
 * definition placed inside the experiments root — still refused exactly like
 * a supervised attempt's own load — resolves `ok: false` with the rejection
 * reason, never throwing.
 * @module verify.spec
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyAcceptance } from '../src/verify.ts'

/** Absolute path of the fake acceptance command fixture, shared with acceptor.spec.ts. */
const fixture = fileURLToPath(new URL('./fixtures/fake-case.mjs', import.meta.url))

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** A temporary experiments tree with one worktree inside it, and the definition path outside it. */
async function makeFixture(): Promise<{ experimentsRoot: string; worktree: string; acceptancePath: string }> {
  root = await mkdtemp(join(tmpdir(), 'self-dev-verify-acceptance-'))
  const experimentsRoot = join(root, 'experiments')
  const worktree = join(experimentsRoot, 'wt')
  await mkdir(worktree, { recursive: true })
  return { experimentsRoot, worktree, acceptancePath: join(root, 'acceptance.json') }
}

describe('verifyAcceptance', () => {
  it('resolves ok:true with the observed report when every case passes', async () => {
    const { experimentsRoot, worktree, acceptancePath } = await makeFixture()
    await writeFile(acceptancePath, JSON.stringify({
      cases: [{
        caseId: 'case-pass',
        command: ['node', fixture, 'exit', '0'],
        timeoutMs: 5000,
        assertions: [{ assertionId: 'case-pass-exit', kind: 'exit-code', expected: 0 }],
      }],
    }))
    const result = await verifyAcceptance(worktree, acceptancePath, { experimentsRoot, killGraceMs: 200 })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.report.exitCode).toBe(0)
    expect(result.report.cases).toEqual([
      { caseId: 'case-pass', assertions: [{ assertionId: 'case-pass-exit', status: 'pass' }] },
    ])
  })

  it('applies a configured sandbox to the case processes, with enabled:false spawning them unconfined', async () => {
    const { experimentsRoot, worktree, acceptancePath } = await makeFixture()
    await writeFile(acceptancePath, JSON.stringify({
      cases: [{
        caseId: 'case-pass',
        command: ['node', fixture, 'exit', '0'],
        timeoutMs: 5000,
        assertions: [{ assertionId: 'case-pass-exit', kind: 'exit-code', expected: 0 }],
      }],
    }))
    const disabled = await verifyAcceptance(worktree, acceptancePath, {
      experimentsRoot,
      killGraceMs: 200,
      sandbox: { enabled: false, denyReadRoots: [], extraWritableRoots: [], sandboxExec: '/usr/bin/sandbox-exec' },
    })
    expect(disabled.ok).toBe(true)
    if (!disabled.ok) throw new Error('unreachable')
    expect(disabled.report.cases[0]?.assertions[0]?.status).toBe('pass')
  })

  it('honors a configured phaseTimeoutMs on a run that finishes well within it', async () => {
    const { experimentsRoot, worktree, acceptancePath } = await makeFixture()
    await writeFile(acceptancePath, JSON.stringify({
      cases: [{
        caseId: 'case-pass',
        command: ['node', fixture, 'exit', '0'],
        timeoutMs: 5000,
        assertions: [{ assertionId: 'case-pass-exit', kind: 'exit-code', expected: 0 }],
      }],
    }))
    const result = await verifyAcceptance(worktree, acceptancePath, { experimentsRoot, killGraceMs: 200, phaseTimeoutMs: 5000 })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.report.exitCode).toBe(0)
  })

  it('resolves ok:false with the rejection reason when the acceptance definition resolves inside the experiments root', async () => {
    const { experimentsRoot, worktree } = await makeFixture()
    // Placed inside experimentsRoot instead of outside it: loadAcceptance
    // refuses this placement — before reading the definition's content, which
    // never runs — exactly as it does for a supervised attempt.
    const insidePath = join(experimentsRoot, 'acceptance.json')
    await writeFile(insidePath, JSON.stringify({
      cases: [{
        caseId: 'case-1',
        command: ['node', fixture, 'exit', '0'],
        timeoutMs: 5000,
        assertions: [{ assertionId: 'case-1-exit', kind: 'exit-code', expected: 0 }],
      }],
    }))
    const result = await verifyAcceptance(worktree, insidePath, { experimentsRoot, killGraceMs: 200 })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toContain('must live outside the experiments root')
  })
})
