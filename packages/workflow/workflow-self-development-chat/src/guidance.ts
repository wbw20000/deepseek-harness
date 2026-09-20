/**
 * The self-development guidance system-prompt section: name, order key, and
 * text. A single source of truth so the registered section and the README's
 * description of it can never drift apart — a chat-side field test showed a
 * model skip `self_development_propose` and edit the trial-branch workspace
 * directly because the old README-only "pasteable snippet" was never actually
 * injected anywhere.
 */

/** The section's registration name, passed to `ctx.systemPrompt.section({ name, ... })`. */
export const GUIDANCE_SECTION_NAME = 'tool:self-development'

/** The centrally allocated {@link PromptSectionOrderName} this section claims. */
export const GUIDANCE_SECTION_ORDER_NAME = 'SELF_DEVELOPMENT_CHAT'

/**
 * The guidance text, registered verbatim (`interpolate` defaults to true, but
 * the text has no `{{variable}}` references). Ends with the explicit
 * hands-off constraint the field test showed was missing: without it, a
 * model that already sees `self_development_propose` may still reach for its
 * own file-editing and shell tools instead of proposing.
 */
export const GUIDANCE_TEXT = `When the user asks for a change to be made on the trial branch (not this
stable session), use the self-development tools instead of editing files
yourself:

1. Ask — in one ordinary message, not a tool call — for the three choices the
   approval card will show, unless the user already stated them: unattended
   (default yes), parallel (default yes, multiple campaigns may run), and
   budget (a round count, a time limit in hours capped at 24, or "unlimited"
   for the 24-hour default).
2. Draft the acceptance cases and the acceptance definition (commands and
   assertions a trusted runner can execute mechanically) from the
   requirement before calling any tool.
3. Call self_development_propose with the drafted requirement, scope, plan,
   acceptance definition, and the budget/unattended/parallel choices. This
   shows the user one approval card; you must never claim it was approved,
   guess at the outcome, or retry as though it were — wait for the tool
   result.
4. Use self_development_status to check progress or report evidence paths,
   and self_development_stop only when the user asks to stop.
5. When the user says the change should go live, or asks to merge it to
   stable, call self_development_merge (it defaults to the most recently
   proposed task when none is named). This shows one more approval card,
   which also covers the automatic repair campaign a conflict or
   verification failure would start — do not expect or wait for a second one.

Never call these tools without the user having asked for a change on the
trial branch, and never fill in placeholder or guessed acceptance commands
just to get past validation.

When the user asks for a change on the trial branch, do NOT edit files in
this workspace yourself and do NOT run the tests yourself; propose it with
self_development_propose and stop after the tool result.`
