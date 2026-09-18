/**
 * Fake headless CLI for executor tests: invoked as
 * `node fake-dsh.mjs --profile headless --json <task>` and keyed on the task
 * text, mirroring the `dsh --profile headless --json` event vocabulary
 * (`session`, `status`/`step_start`, `text`, `error`).
 *
 * Behaviors:
 * - `ok`      → session event, one other-phase status, 3 step_starts, text "done", exit 0.
 * - `steps-5` → session event, 5 step_starts, then stays alive (default-death on SIGTERM).
 * - `graceful`→ session event, 5 step_starts, then stays alive but exits 0 on SIGTERM.
 * - `flood-events` → session event, then 300 1 KiB `text` events written synchronously to
 *               fd 1 immediately before exiting 0, so the last events are still in the
 *               kernel pipe when the process dies.
 * - `flood-stdout` → session event, 5 step_starts, 2000 1 KiB `text` events (2 MiB), one
 *               more step_start, exit 0.
 * - `late-writes` → session event, then exits 0 immediately after spawning a grandchild
 *               that shares stdout and only writes 3 step_starts + 10 `text` events
 *               300 ms later, after the CLI process itself is already gone.
 * - `slow`    → session event, ignores SIGTERM, keeps the loop alive until SIGKILL.
 * - `slow-steps` → session event, 3 step_starts with the third 300 ms in, then ignores
 *               SIGTERM and stays alive until SIGKILL; the delayed step fires the step
 *               cap while the phase deadline is still far off, so a cancellation that
 *               follows during the kill grace (400 ms in the no-restart test) must not
 *               re-arm it — only the original grace's SIGKILL ends the run.
 * - `orphan`  → spawns `sleep 30` inside its own process group, announces the pid in a
 *               text event and in `./orphan-grandchild.pid` inside its cwd, stays alive.
 * - `fail`    → parser-tolerance noise (blank line, non-JSON, `null`, JSON number, session
 *               event without a sessionId, text event without text), 10 KiB of stderr ending
 *               in a marker, an `error` event, exit 1.
 */

const [, , profileFlag, profile, jsonFlag, task] = process.argv
if (profileFlag !== '--profile' || profile !== 'headless' || jsonFlag !== '--json' || task === undefined) {
  console.error('fake-dsh requires: --profile headless --json <task>')
  process.exit(2)
}

/** Write one NDJSON event and report whether it drained synchronously. */
function emit(event) {
  return process.stdout.write(`${JSON.stringify(event)}\n`)
}

if (task === 'ok') {
  emit({ type: 'session', sessionId: 'session-fake-ok', cwd: process.cwd() })
  emit({ type: 'status', phase: 'turn_start', turn: 1 })
  for (const step of [1, 2, 3]) emit({ type: 'status', phase: 'step_start', turn: 1, step })
  emit({ type: 'text', text: 'done' })
  process.exitCode = 0
} else if (task === 'unicode-tail') {
  emit({ type: 'session', sessionId: 'first-session' })
  emit({ type: 'session', sessionId: 'replacement-session' })
  const bytes = Buffer.from(JSON.stringify({ type: 'text', text: '中文🙂' }))
  for (const byte of bytes) await new Promise((resolve) => process.stdout.write(Buffer.from([byte]), resolve))
} else if (task === 'steps-5') {
  emit({ type: 'session', sessionId: 'session-fake-steps', cwd: process.cwd() })
  for (const step of [1, 2, 3, 4, 5]) emit({ type: 'status', phase: 'step_start', turn: 1, step })
  // Stay alive so the runner's SIGTERM (default disposition) is what ends the run.
  setInterval(() => {}, 1_000)
} else if (task === 'slow') {
  emit({ type: 'session', sessionId: 'session-fake-slow', cwd: process.cwd() })
  process.on('SIGTERM', () => {})
  setInterval(() => {}, 1_000)
} else if (task === 'slow-steps') {
  emit({ type: 'session', sessionId: 'session-fake-slow-steps', cwd: process.cwd() })
  for (const step of [1, 2]) emit({ type: 'status', phase: 'step_start', turn: 1, step })
  // The third step at 300 ms fires the step cap long before the phase
  // deadline; SIGTERM is ignored, so only the SIGKILL that follows the
  // original kill grace (400 ms in the no-restart test) can end the run.
  setTimeout(() => emit({ type: 'status', phase: 'step_start', turn: 1, step: 3 }), 300)
  process.on('SIGTERM', () => {})
  setInterval(() => {}, 1_000)
} else if (task === 'graceful') {
  emit({ type: 'session', sessionId: 'session-fake-graceful', cwd: process.cwd() })
  for (const step of [1, 2, 3, 4, 5]) emit({ type: 'status', phase: 'step_start', turn: 1, step })
  // Real CLIs commonly catch SIGTERM and shut down cleanly: exit 0 on teardown.
  process.on('SIGTERM', () => {
    process.exit(0)
  })
  setInterval(() => {}, 1_000)
} else if (task === 'flood-events' || task === 'flood-stdout') {
  const { writeSync } = await import('node:fs')
  // writeSync lands every byte in the kernel pipe before the process dies,
  // so the stream only drains after the child is gone.
  const emitSync = (event) => writeSync(1, `${JSON.stringify(event)}\n`)
  emitSync({ type: 'session', sessionId: `session-fake-${task}`, cwd: process.cwd() })
  const textEvents = task === 'flood-events' ? 300 : 2000
  if (task === 'flood-stdout') {
    for (const step of [1, 2, 3, 4, 5]) emitSync({ type: 'status', phase: 'step_start', turn: 1, step })
  }
  for (const index of Array.from({ length: textEvents }, (_, i) => i)) {
    emitSync({ type: 'text', text: `evt-${index}-${'x'.repeat(1000)}` })
  }
  if (task === 'flood-stdout') emitSync({ type: 'status', phase: 'step_start', turn: 1, step: 6 })
  process.exitCode = 0
} else if (task === 'late-writes') {
  const { spawn } = await import('node:child_process')
  emit({ type: 'session', sessionId: 'session-fake-late-writes', cwd: process.cwd() })
  // The grandchild shares the CLI's stdout pipe and outlives the CLI, so the
  // pipe only reaches EOF (and `close` fires) after these events drain.
  const lateScript = [
    "const { writeSync } = require('node:fs');",
    'setTimeout(() => {',
    "  for (const step of [1, 2, 3]) writeSync(1, JSON.stringify({ type: 'status', phase: 'step_start', turn: 1, step }) + '\\n');",
    "  for (const i of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) writeSync(1, JSON.stringify({ type: 'text', text: 'late-evt-' + i + '-' }) + '\\n');",
    '}, 300);',
  ].join('\n')
  const grandchild = spawn(process.execPath, ['-e', lateScript], { stdio: ['ignore', 'inherit', 'ignore'] })
  grandchild.unref()
  process.exitCode = 0
} else if (task === 'orphan' || task === 'orphan-exit') {
  emit({ type: 'session', sessionId: 'session-fake-orphan', cwd: process.cwd() })
  const { spawn } = await import('node:child_process')
  const { writeFileSync } = await import('node:fs')
  const grandchild = spawn('sleep', ['30'], { detached: false, stdio: 'ignore' })
  writeFileSync(`${process.cwd()}/orphan-grandchild.pid`, String(grandchild.pid))
  emit({ type: 'text', text: `grandchild-pid:${String(grandchild.pid)}` })
  if (task === 'orphan-exit') grandchild.unref()
  else setInterval(() => {}, 1_000)
} else if (task === 'fail') {
  process.stdout.write('\n')
  process.stdout.write('fake-dsh: this line is not JSON\n')
  process.stdout.write('null\n')
  process.stdout.write('123\n')
  emit({ type: 'session' })
  emit({ type: 'text' })
  process.stderr.write('HEAD-OF-STDERR-MARKER\n')
  process.stderr.write(`${'e'.repeat(10 * 1024)}`)
  process.stderr.write('STDERR-TAIL-MARKER\n')
  emit({ type: 'error', message: 'fake-dsh boom' })
  process.exitCode = 1
} else {
  console.error(`fake-dsh: unknown task ${JSON.stringify(task)}`)
  process.exit(2)
}
