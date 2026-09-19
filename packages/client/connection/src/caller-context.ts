/** Ambient caller identity for Host-side request and stream handling. */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { ConnectionCaller } from './rpc.ts'

export type { ConnectionCaller }

/**
 * AsyncLocalStorage scope holding the {@link ConnectionCaller} of the request
 * being served. Connection's Fetch dispatch and API Gateway's Remote stream
 * dispatch run their handlers inside `run`, so business code reads the caller
 * with `current()` without threading request facts through every signature.
 * This class stays host-only: the shared `rpc.ts` face carries the structural
 * `ConnectionCallerScope` view because the browser face has no node types.
 */
export class ConnectionCallerContext {
  private readonly storage = new AsyncLocalStorage<ConnectionCaller>()

  /**
   * Run one handler with `caller` as the ambient identity. Nested runs shadow
   * the outer identity for their own async chain only; concurrent runs stay
   * isolated because AsyncLocalStorage binds the store per async execution.
   * @param caller - identity visible to `fn` and everything it awaits.
   * @param fn - handler to execute; a returned promise keeps the identity across suspension points.
   * @returns whatever `fn` returns.
   */
  run<T>(caller: ConnectionCaller, fn: () => T): T {
    return this.storage.run(caller, fn)
  }

  /**
   * Read the ambient caller identity.
   * @returns the identity installed by the enclosing `run`, or undefined when called outside any scope.
   */
  current(): ConnectionCaller | undefined {
    return this.storage.getStore()
  }
}
