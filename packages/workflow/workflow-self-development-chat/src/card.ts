/** Bilingual approval-card copy for the proposal approval request. */

import type { ProposeBudget, ResolvedProposeInput } from './types.ts'

/** The two card languages; the deployment picks one through `cardLocale`. */
export type CardLocale = 'zh' | 'en'

/** Budget terms in card copy. */
function budgetText(budget: ProposeBudget, locale: CardLocale): string {
  if ('preset' in budget) return locale === 'zh' ? '不限制（无步数/调用/token 上限；总时长 24 小时兜底）' : 'unlimited (no step, call, or token cap; 24h total ceiling)'
  if (budget.mode === 'rounds') {
    return locale === 'zh' ? `轮数上限 ${budget.maxRounds}` : `max ${budget.maxRounds} rounds`
  }
  return locale === 'zh' ? `时间上限 ${budget.hours} 小时` : `time capped at ${budget.hours}h`
}

/**
 * Build the approval-card reason: requirement, acceptance cases, budget,
 * unattended choice, and workspace, in the configured language. The card is
 * the only decision surface: the user's single approval launches the whole
 * campaign, so the copy names everything it covers. The workspace line shows
 * the experiments root and the acceptance path, both fixed before the
 * approval; the per-task worktree is allocated after the approval.
 * @param input - the validated proposal input, with every default applied.
 * @param paths - the derived task id, experiments root, and acceptance-definition path.
 * @param locale - card language.
 * @returns the multi-line reason shown on the approval card.
 */
export function approvalReason(
  input: ResolvedProposeInput,
  paths: { readonly taskId: string; readonly experimentsRoot: string; readonly acceptancePath: string },
  locale: CardLocale,
): string {
  if (locale === 'en') {
    return [
      `Requirement: ${input.requirement}`,
      `Acceptance cases: ${input.plan.requiredCases.map(requiredCase => requiredCase.caseId).join(', ')}`
        + (input.plan.manualCases.length > 0 ? `; manual: ${input.plan.manualCases.join(', ')}` : ''),
      `Budget: ${budgetText(input.budget, locale)}`,
      `Unattended: ${input.unattended ? 'yes — one approval covers every round, no OS isolation' : 'no — every round asks again'}`,
      `Workspace: ${paths.experimentsRoot} (task ${paths.taskId})`,
      `Acceptance definition: ${paths.acceptancePath}`,
    ].join('\n')
  }
  return [
    `需求：${input.requirement}`,
    `验收用例：${input.plan.requiredCases.map(requiredCase => requiredCase.caseId).join('、')}`
      + (input.plan.manualCases.length > 0 ? `；人工核验：${input.plan.manualCases.join('、')}` : ''),
    `预算：${budgetText(input.budget, locale)}`,
    `无人值守：${input.unattended ? '是——一次确认覆盖全部轮次，无 OS 隔离' : '否——每轮再次确认'}`,
    `工作区：${paths.experimentsRoot}（任务 ${paths.taskId}）`,
    `验收定义：${paths.acceptancePath}`,
  ].join('\n')
}

/**
 * Build the merge approval-card reason: task, result summary, target branch,
 * and the two automated consequences of approving — the rebuild/restart and
 * the repair campaign on conflict or verification failure. Naming the repair
 * campaign here is what lets `self_development_merge` skip a second approval
 * card for it (see `merge.ts`'s `skipApprovalDetail`): the user was already
 * told, in this one card, that approving covers that too.
 * @param input - the task id, its requirement when known, and the configured target branch.
 * @param locale - card language.
 * @returns the multi-line reason shown on the approval card.
 */
export function mergeApprovalReason(
  input: { readonly taskId: string; readonly requirement: string | undefined; readonly targetBranch: string },
  locale: CardLocale,
): string {
  if (locale === 'en') {
    return [
      `Task: ${input.taskId}${input.requirement === undefined ? '' : ` — ${input.requirement}`}`,
      'Result: merge the passed campaign\'s worktree into the stable branch',
      `Target branch: ${input.targetBranch}`,
      'This rebuilds and restarts the stable version.',
      'A conflict or verification failure automatically starts a repair campaign — this approval also covers that, so it will not ask again.',
    ].join('\n')
  }
  return [
    `任务：${input.taskId}${input.requirement === undefined ? '' : `——${input.requirement}`}`,
    '结果：把已通过战役的工作区合并进稳定分支',
    `目标分支：${input.targetBranch}`,
    '这会重建并重启稳定版。',
    '出现冲突或验证失败时会自动起一个修复战役——这次批准已经覆盖那一步，不会再弹第二张审批卡。',
  ].join('\n')
}
