// Fake outbound command that starts one grandchild and idles forever, so the
// delivery timeout must stop the whole spawned process group. Writes both pids
// to the file named by argv[2] before idling.

import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: false })
writeFileSync(process.argv[2], `${JSON.stringify({ pid: process.pid, childPid: grandchild.pid })}\n`)
setInterval(() => {}, 1000)
