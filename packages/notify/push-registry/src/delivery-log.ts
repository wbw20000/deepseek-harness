/** Token-free JSONL delivery log inside the registry directory. */

import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { DeliveryRecord } from './types.ts'

const LOG_FILENAME = 'deliveries.jsonl'

/** Append-only delivery log. Records never contain device tokens. */
export class DeliveryLog {
  /** Absolute path of the backing JSONL file. */
  readonly path: string

  /** @param directory - absolute registry directory. */
  constructor(directory: string) {
    this.path = join(directory, LOG_FILENAME)
  }

  /**
   * Append one delivery record.
   * @param record - completed delivery result.
   * @returns completion once the line is written.
   */
  async append(record: DeliveryRecord): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    await appendFile(this.path, `${JSON.stringify(record)}\n`, { encoding: 'utf8' })
  }
}
