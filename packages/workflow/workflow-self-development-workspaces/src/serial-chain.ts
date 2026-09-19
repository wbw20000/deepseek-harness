/**
 * In-process serial chains for operations that must not interleave. Each
 * experiments root gets one chain: a call appended to the chain runs only
 * after every earlier call has settled, whatever their outcome. Allocation
 * and release run on the same chain so their registry read-modify-write
 * cycles cannot overwrite each other and the concurrency limit is exact;
 * integration runs its own chain on the service instance and additionally
 * takes the cross-process file lock. Chains serialize calls within one
 * process only; across processes the deployment still keeps one writer per
 * experiments root.
 * @module @deepseek-ai/dsh-workflow-self-development-workspaces/serial-chain
 */

/** Chain tails, keyed by the experiments root the calls operate on. */
const tails = new Map<string, Promise<unknown>>()

/**
 * Run `fn` after every earlier call chained on `key` in this process has
 * settled. The chain survives a rejected call: the next call still runs.
 * @typeParam T - result of the serialized work.
 * @param key - the resource the chain serializes on, here the experiments root.
 * @param fn - the serialized work.
 * @returns whatever `fn` resolves with, or its rejection.
 */
export function runInSerialChain<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (tails.get(key) ?? Promise.resolve()).then(fn, fn)
  const tail = run.then(() => undefined, () => undefined)
  tails.set(key, tail)
  // Drop the chain once it drains, so finished experiments roots do not pin
  // memory; a later call that already chained onto this tail keeps it alive.
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key)
  })
  return run
}
