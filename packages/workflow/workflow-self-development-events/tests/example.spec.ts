/**
 * End-to-end behavior of the `examples/macos-notify.sh` template: it parses
 * the event JSON from stdin, escapes the fields, and hands osascript one
 * argv — shell-active characters in event text never reach a shell.
 * @module example.spec
 */

import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SelfDevelopmentEvent } from '../src/types.ts'

/** Repo-relative path of the notification template. */
const SCRIPT = new URL('../examples/macos-notify.sh', import.meta.url).pathname

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Run the template with a stub osascript that appends its argv to a file. */
async function runTemplate(event: SelfDevelopmentEvent, stubLog: string): Promise<void> {
  const bin = root as string
  await writeFile(join(bin, 'osascript'), `#!/bin/sh\nprintf '%s\\n' "$@" >> '${stubLog}'\n`, { mode: 0o755 })
  await new Promise<void>((resolve, reject) => {
    execFile(SCRIPT, {
      env: { PATH: `${bin}:/usr/bin:/bin` },
    }, (error, stdout, stderr) => {
      if (error !== null) reject(new Error(`macos-notify.sh failed: ${error.message} ${stderr}${stdout}`))
      else resolve()
    }).stdin?.end(`${JSON.stringify(event)}\n`)
  })
}

describe('examples/macos-notify.sh', () => {
  it('posts one escaped notification per event without interpreting the fields', async () => {
    root = await mkdtemp(join(tmpdir(), 'self-dev-example-'))
    const stubLog = join(root, 'osascript-args.log')
    const event: SelfDevelopmentEvent = {
      taskId: 'task-9',
      kind: 'failed',
      sessionId: undefined,
      title: 'Round 1 failed: boom `rm -rf /` $(cat /etc/passwd) "quoted"',
      occurredAt: 1_700_000_000_000,
      revision: 7,
    }
    await runTemplate(event, stubLog)
    const args = (await readFile(stubLog, 'utf8')).trim().split('\n')
    expect(args[0]).toBe('-e')
    expect(args[1]).toBe(
      'display notification "Round 1 failed: boom `rm -rf /` $(cat /etc/passwd) \\"quoted\\"" with title "task-9"',
    )
  })
})
