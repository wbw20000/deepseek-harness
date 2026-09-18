// Fake outbound command: appends the stdin payload to the file named by
// argv[2] and exits 0. Used by the push-registry specs as the delivery target.

import { appendFileSync } from 'node:fs'

const chunks = []
process.stdin.on('data', chunk => chunks.push(chunk))
process.stdin.on('end', () => {
  appendFileSync(process.argv[2], Buffer.concat(chunks).toString('utf8'))
  process.exit(0)
})
