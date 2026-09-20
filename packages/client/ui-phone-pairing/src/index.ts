/**
 * Phone pairing UI plugin, node half. Pure UI plugin: the browser half adds
 * one Settings section on the stable host that mints one-time pairing links
 * (rendered as QR codes) and manages the paired browser sessions through the
 * Connection package's own session routes. The host loader entry itself
 * registers nothing; Connection owns every route the section calls.
 */

/** Host plugin body — no host-side behavior for the phone pairing UI plugin. */
export function apply(): void {}
