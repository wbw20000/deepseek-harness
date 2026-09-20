/**
 * Fake setup command for the workspace-setup tests. The service spawns this
 * script the way it spawns a deployment-configured setup command and asserts
 * on whatever it does.
 *
 * Usage: node setup-case.mjs <behavior> [args...]
 * Behaviors:
 *   write <relpath> <text>  write text to relpath (relative to cwd), exit 0
 *   append <path> <text>    append text to an absolute path, exit 0 — used to
 *                           prove a script ran exactly once across repeats
 *   exit <code>             exit with the given code
 *   fail <code> <text>      write text to stdout and stderr, then exit with the given non-zero code
 *   check-exists <path>     exit 0 when the absolute path exists, else exit 9
 *   sleep <ms>              stay alive for ms, then exit 0
 *   crash                   terminate this process with SIGTERM
 *   spawn-grandchild <pidfile> <ms>
 *                           spawn a detached-from-this-process-but-same-group
 *                           grandchild that writes its own pid to pidfile and
 *                           sleeps ms, then this process also sleeps ms
 */

import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const [behavior, ...args] = process.argv.slice(2)

function write(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

switch (behavior) {
  case 'write':
    write(args[0], args[1] ?? '')
    break
  case 'exit':
    process.exit(Number(args[0]))
    break
  case 'fail':
    process.stdout.write(args[1] ?? '')
    process.stderr.write(args[1] ?? '')
    process.exit(Number(args[0]))
    break
  case 'append':
    mkdirSync(dirname(args[0]), { recursive: true })
    appendFileSync(args[0], args[1] ?? '')
    break
  case 'check-exists':
    process.exit(existsSync(args[0]) ? 0 : 9)
    break
  case 'sleep':
    setTimeout(() => {}, Number(args[0]))
    break
  case 'crash':
    process.kill(process.pid, 'SIGTERM')
    break
  case 'spawn-grandchild': {
    const [pidfile, ms] = args
    // No `detached: true` here: the grandchild stays in this process's own
    // POSIX process group (the group the parent's caller will signal), it
    // just is not itself the group leader.
    const child = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${JSON.stringify(Number(ms))})`])
    write(pidfile, String(child.pid))
    setTimeout(() => {}, Number(ms))
    break
  }
  default:
    process.exit(64)
}
