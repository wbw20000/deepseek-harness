/**
 * Fake headless CLI for supervised-attempt tests: invoked as
 * `node fake-dsh-attempt.mjs --profile headless --json <task>` and keyed on
 * the task text, mirroring the `dsh --profile headless --json` event
 * vocabulary (`session`, `status`, `text`, `error`).
 *
 * Launch accounting lives under `$DSH_HOME`, never in the experiment
 * worktree: a launch that only records itself must not change the content the
 * attempt is judged against.
 * - `<dshHome>/launches`  one line per launch, the task text
 * - `<dshHome>/last-pgid` this process's pid, which equals its process group
 *   id because the executor spawns it detached
 *
 * Behaviors:
 * - `dev`   → write `marker.txt` (`WIP2` on the first launch, `DONE` after),
 *             emit three step events, exit 0.
 * - `steps` → same as `dev`; used with a step cap of 1, so the second step
 *             event fires the cap.
 * - `hang`  → write `marker.txt` `WIP2`, ignore SIGTERM, stay alive until
 *             SIGKILL; proves teardown of an uncooperative child.
 * - `fail`  → change nothing, emit an error event, exit 1; lets a retry with
 *             the same operation id replay instead of launching again.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [, , profileFlag, profile, jsonFlag, task] = process.argv
if (profileFlag !== '--profile' || profile !== 'headless' || jsonFlag !== '--json' || task === undefined) {
  console.error('fake-dsh-attempt requires: --profile headless --json <task>')
  process.exit(2)
}

const home = process.env.DSH_HOME
if (home === undefined || home.length === 0) {
  console.error('fake-dsh-attempt requires DSH_HOME')
  process.exit(2)
}

/** Write one NDJSON event to the executor's stdout. */
function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`)
}

// Launch accounting under DSH_HOME, before any worktree write.
mkdirSync(home, { recursive: true })
appendFileSync(join(home, 'launches'), `${task}\n`)
writeFileSync(join(home, 'last-pgid'), String(process.pid))
emit({ type: 'session', sessionId: `session-${task}`, cwd: process.cwd() })

if (task === 'dev' || task === 'steps' || task === 'hang') {
  const launches = readFileSync(join(home, 'launches'), 'utf8').trim().split('\n').length
  writeFileSync('marker.txt', launches === 1 ? 'WIP2' : 'DONE')
  emit({ type: 'text', text: 'done' })
} else {
  emit({ type: 'error', error: 'the fake CLI declined this task' })
  process.exit(1)
}

if (task === 'hang') {
  process.on('SIGTERM', () => {})
  setInterval(() => {}, 1_000)
} else {
  for (const step of [1, 2, 3]) emit({ type: 'status', phase: 'step_start', turn: 1, step })
}
