// Fake notification command: writes the raw stdin bytes it receives to the
// file named by argv[2], appending one invocation per line. Direct unit-test
// fixture for the events service's local-notification delivery.

import { appendFileSync } from 'node:fs'

const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
appendFileSync(process.argv[2], Buffer.concat(chunks))
