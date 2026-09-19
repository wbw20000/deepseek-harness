/**
 * Self-development task UI plugin, node half. Pure UI plugin: the browser half
 * renders the M4 confirmation card, the per-round evidence timeline, and the
 * explicit human authorization buttons, and consumes one host service a
 * profile may or may not load — the `selfDevelopmentRemote` Typert facade (its
 * generated client namespace is mounted into the browser `remote` service; the
 * per-round timeline reads that facade's `recentEvents`). It is not required:
 * when absent the panel renders its not-enabled view instead of failing,
 * because ordinary chat compositions never carry this opt-in service. The
 * host loader entry itself registers nothing.
 */

/** Host plugin body — no host-side behavior for the self-development UI plugin. */
export function apply(): void {}
