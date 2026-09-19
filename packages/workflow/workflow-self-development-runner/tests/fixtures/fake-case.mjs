/**
 * Fake acceptance command for the independent acceptor tests. The acceptor
 * spawns this script the way it spawns a real experiment's acceptance command
 * and evaluates assertions against whatever it does.
 *
 * Usage: node fake-case.mjs <behavior> [args...]
 * Behaviors:
 *   exit <code>            exit with the given code
 *   echo <text...>         write the text plus a newline to stdout, exit 0
 *   read <path>            write the file's text to stdout, exit 0
 *   write <relpath> <text> write the text to relpath (relative to cwd), exit 0
 *   write-dsh-home <relpath>
 *                          write this process's `DSH_HOME` (or the empty string
 *                          without one) to relpath (relative to cwd), exit 0
 *   sleep <ms>             stay alive for ms, then exit 0
 *   hang <ms>              stay alive for ms while ignoring SIGTERM
 *   crash                  terminate this process with SIGTERM
 *   pidfile <path> <ms>    write this process's pid to path, then sleep ms
 *   flood <bytes> [text]   write the optional text first, then bytes of filler
 *                          stdout, then a trailing "truncation-marker" line
 */

import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const [behavior, ...args] = process.argv.slice(2)

switch (behavior) {
  case 'exit':
    process.exit(Number(args[0]))
    break
  case 'echo':
    process.stdout.write(`${args.join(' ')}\n`)
    break
  case 'read':
    process.stdout.write(readFileSync(args[0], 'utf8'))
    break
  case 'write':
    mkdirSync(dirname(args[0]), { recursive: true })
    writeFileSync(args[0], args.slice(1).join(' '))
    break
  case 'write-dsh-home':
    mkdirSync(dirname(args[0]), { recursive: true })
    writeFileSync(args[0], process.env.DSH_HOME ?? '')
    break
  case 'symlink':
    symlinkSync(args[0], args[1])
    break
  case 'sleep':
    setTimeout(() => {}, Number(args[0]))
    break
  case 'hang':
    process.on('SIGTERM', () => {})
    setTimeout(() => {}, Number(args[0]))
    break
  case 'crash':
    process.kill(process.pid, 'SIGTERM')
    break
  case 'pidfile':
    writeFileSync(args[0], String(process.pid))
    setTimeout(() => {}, Number(args[1]))
    break
  case 'flood': {
    const marker = args.slice(1).join(' ')
    if (marker !== '') process.stdout.write(`${marker}\n`)
    process.stdout.write('a'.repeat(Number(args[0])))
    process.stdout.write('truncation-marker\n')
    break
  }
  default:
    process.exit(64)
}
