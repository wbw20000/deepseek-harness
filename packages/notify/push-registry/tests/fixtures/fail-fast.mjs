// Fake outbound command that always fails: records one marker line and exits 1.

import { appendFileSync } from 'node:fs'

appendFileSync(process.argv[2], 'called\n')
process.exit(1)
