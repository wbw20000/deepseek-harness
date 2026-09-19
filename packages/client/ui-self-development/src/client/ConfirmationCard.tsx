/**
 * The read-only confirmation card of one task. Every field renders the wire
 * view verbatim, in the fixed wording the human-review card template fixes:
 * the facade's `无依据` budget basis and `未知，不放行` cost limits are shown
 * exactly as received, and absent budget terms render the unset label. The
 * card holds no button and computes no decision.
 */
import type { ReactNode } from 'react'
import type { RequiredCase } from '@deepseek-ai/dsh-workflow-self-development'
import type { ConfirmationCard as CardView } from '@deepseek-ai/dsh-workflow-self-development-remote'
import { budgetModeKey } from './status.ts'
import type { Translate } from './status.ts'
import css from './SelfDevelopmentPanel.module.css'

/** Props of the confirmation card. */
export interface ConfirmationCardProps {
  /** The dictionary seat. */
  readonly t: Translate
  /** The card view as the facade built it. */
  readonly card: CardView
}

/** One field row: a localized label and a verbatim or unset value. */
function Field({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div className={css.field}>
      <span className={css.fieldLabel}>{label}</span>
      <span className={css.fieldValue}>{value}</span>
    </div>
  )
}

/** The budget terms as label/value rows; absent terms render the unset label. */
function BudgetRows({ t, card }: { t: Translate; card: CardView }): ReactNode {
  const budget = card.budget
  const unset = t('unset')
  const rows: readonly (readonly [string, string])[] = [
    [t('cardBudgetMaxRounds'), budget.maxRounds === undefined ? unset : String(budget.maxRounds)],
    [t('cardBudgetDuration'), budget.durationMs === undefined ? unset : String(budget.durationMs)],
    [t('cardBudgetPhaseTimeout'), budget.phaseTimeoutMs === undefined ? unset : String(budget.phaseTimeoutMs)],
    [t('cardBudgetSteps'), budget.maxStepsPerAttempt === undefined ? unset : String(budget.maxStepsPerAttempt)],
    [t('cardBudgetNoProgress'), budget.noProgressAttemptLimit === undefined ? unset : String(budget.noProgressAttemptLimit)],
  ]
  return (
    <div className={css.field}>
      <span className={css.fieldLabel}>{t('cardBudget')}</span>
      <span className={css.fieldValue}>
        <span className={css.budgetMode}>
          {budget.mode === undefined ? unset : t(budgetModeKey(budget.mode))}
        </span>
        {rows.map(([label, value]) => (
          <span key={label} className={css.budgetRow}>{label}: {value}</span>
        ))}
      </span>
    </div>
  )
}

/** One acceptance case as case id, requirement, and its assertion ids. */
function CaseRow({ t, item }: { t: Translate; item: RequiredCase }): ReactNode {
  return (
    <li className={css.caseRow}>
      <span className={css.caseId}>{item.caseId}</span>
      <span className={css.caseRequirement}>{item.requirement}</span>
      <span className={css.caseAssertions}>
        {t('caseAssertions')}: {item.assertionIds.join(', ')}
      </span>
    </li>
  )
}

/**
 * Render the confirmation card.
 * @param props - the dictionary seat and the card view.
 * @returns the card element tree.
 */
export function ConfirmationCard({ t, card }: ConfirmationCardProps): ReactNode {
  return (
    <section className={css.card} aria-label={t('cardTitle')}>
      <h3 className={css.cardHeading}>{t('cardTitle')}</h3>
      <Field label={t('cardTaskAndGoal')} value={card.taskAndGoal} />
      <Field
        label={t('cardPlanningAuthorized')}
        value={card.planningAuthorized ? t('planningYes') : t('planningNo')}
      />
      <Field label={t('cardBudgetBasis')} value={card.suggestedBudgetBasis} />
      {card.stableBaselineDigest === undefined
        ? null
        : <Field label={t('cardBaseline')} value={card.stableBaselineDigest} />}
      <Field label={t('cardScope')} value={card.allowedModificationScope.join(', ')} />
      <BudgetRows t={t} card={card} />
      <Field
        label={t('cardConsumed')}
        value={`${t('cardConsumedRounds')}: ${card.consumedBudget.rounds} · ${t('cardConsumedTime')}: ${card.consumedBudget.timeMs}`}
      />
      <Field label={t('cardCostLimits')} value={card.costLimits} />
      {card.acceptanceCases.length > 0
        ? (
          <div className={css.field}>
            <span className={css.fieldLabel}>{t('cardAcceptanceCases')}</span>
            <ul className={css.caseList}>
              {card.acceptanceCases.map(item => <CaseRow key={item.caseId} t={t} item={item} />)}
            </ul>
          </div>
        )
        : null}
      {card.manualCases.length > 0
        ? (
          <div className={css.field}>
            <span className={css.fieldLabel}>{t('cardManualCases')}</span>
            <ul className={css.caseList}>
              {card.manualCases.map(item => <li key={item} className={css.caseRow}>{item}</li>)}
            </ul>
          </div>
        )
        : null}
    </section>
  )
}
