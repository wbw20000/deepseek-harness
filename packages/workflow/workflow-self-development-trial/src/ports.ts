/**
 * Loopback port allocation inside the configured range. A port is free when
 * a probe server binds it on `127.0.0.1`; ports already handed to a live
 * instance in this process are refused before the probe, so two rapid opens
 * never observe the same port.
 * @module @deepseek-ai/dsh-workflow-self-development-trial/ports
 */

import { createServer } from 'node:net'
import { SelfDevelopmentTrialError } from './errors.ts'

/**
 * Probe one loopback port by binding it.
 * @param port - the port to probe.
 * @returns true when a server bound `127.0.0.1` on that port and released it again.
 */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => {
      // EADDRINUSE and every other bind refusal mean the port is not usable now.
      resolve(false)
    })
    server.once('listening', () => {
      server.close(() =>{  resolve(true) })
    })
    server.listen(port, '127.0.0.1')
  })
}

/**
 * Allocate one free port in the inclusive range, skipping ports this process
 * already handed to live instances.
 * @param from - inclusive lower bound.
 * @param to - inclusive upper bound.
 * @param taken - ports already allocated to live instances of this process.
 * @returns the first free port, scanning upward from `from`.
 * @throws SelfDevelopmentTrialError with `self-development/trial-port-exhausted` when no port in
 *   the range is free; the message names the configured range.
 */
export async function allocatePort(from: number, to: number, taken: ReadonlySet<number>): Promise<number> {
  for (let port = from; port <= to; port += 1) {
    if (taken.has(port)) continue
    if (await isPortFree(port)) return port
  }
  throw new SelfDevelopmentTrialError(
    'self-development/trial-port-exhausted',
    `every port in the configured trial range ${String(from)}-${String(to)} is occupied; widen portRange or close a trial`,
  )
}
