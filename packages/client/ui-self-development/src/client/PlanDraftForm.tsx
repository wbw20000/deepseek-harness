/**
 * The plan-draft form: one editable row per required acceptance case plus a
 * manual-case list, rendered while the task is planning-authorized. Rows are
 * added and removed locally; the facade's wire schema re-validates the draft.
 */
import { useState, type ReactNode } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PlanDraftInput } from '@deepseek-ai/dsh-workflow-self-development-remote'
import { buildPlanDraft } from './wire.ts'
import type { PlanDraftCaseForm } from './wire.ts'
import type { Translate } from './status.ts'
import css from './SelfDevelopmentPanel.module.css'

/** Props of the plan-draft form: the dictionary seat and the submit callback. */
export interface PlanDraftFormProps {
  /** The dictionary seat. */
  readonly t: Translate
  /** Whether another operation is in flight; disables the submit button. */
  readonly busy: boolean
  /** Submit the draft built from the current rows. */
  readonly onSubmit: (draft: PlanDraftInput) => Promise<void>
}

/** One empty case row; the submit builder drops it until both texts are filled. */
const EMPTY_CASE: PlanDraftCaseForm = { caseId: '', requirement: '', assertionIds: '' }

/**
 * Render the plan-draft form.
 * @param props - the dictionary seat, the busy flag, and the submit callback.
 * @returns the form element tree.
 */
export function PlanDraftForm(props: PlanDraftFormProps): ReactNode {
  const { t, busy, onSubmit } = props
  const [cases, setCases] = useState<readonly PlanDraftCaseForm[]>([EMPTY_CASE])
  const [manualCases, setManualCases] = useState('')

  const ready = cases.some(row => row.caseId.trim() !== '' && row.requirement.trim() !== '')

  const setCase = (index: number, patch: Partial<PlanDraftCaseForm>): void => {
    setCases(cases.map((row, at) => at === index ? { ...row, ...patch } : row))
  }

  return (
    <section className={css.form} aria-label={t('planDraftTitle')}>
      {cases.map((row, index) => (
        <div key={index} className={css.caseRow}>
          <div className={css.formRow}>
            <label className={css.formLabel} htmlFor={`dsh-self-dev-case-id-${index}`}>{t('planDraftCaseId')}</label>
            <Input
              id={`dsh-self-dev-case-id-${index}`}
              value={row.caseId}
              onChange={(event) => { setCase(index, { caseId: event.currentTarget.value }) }}
            />
          </div>
          <div className={css.formRow}>
            <label className={css.formLabel} htmlFor={`dsh-self-dev-case-requirement-${index}`}>{t('formRequirement')}</label>
            <Input
              id={`dsh-self-dev-case-requirement-${index}`}
              value={row.requirement}
              onChange={(event) => { setCase(index, { requirement: event.currentTarget.value }) }}
            />
          </div>
          <div className={css.formRow}>
            <label className={css.formLabel} htmlFor={`dsh-self-dev-case-assertions-${index}`}>{t('planDraftAssertions')}</label>
            <Input
              id={`dsh-self-dev-case-assertions-${index}`}
              value={row.assertionIds}
              onChange={(event) => { setCase(index, { assertionIds: event.currentTarget.value }) }}
            />
          </div>
          <Button
            size="sm"
            disabled={cases.length === 1}
            onClick={() => { setCases(cases.filter((_, at) => at !== index)) }}
          >
            {t('planDraftRemoveCase')}
          </Button>
        </div>
      ))}
      <div className={css.actions}>
        <Button size="sm" onClick={() => { setCases([...cases, EMPTY_CASE]) }}>{t('planDraftAddCase')}</Button>
      </div>
      <div className={css.formRow}>
        <label className={css.formLabel} htmlFor="dsh-self-dev-manual-cases">{t('planDraftManualCases')}</label>
        <Input
          id="dsh-self-dev-manual-cases"
          value={manualCases}
          onChange={(event) => { setManualCases(event.currentTarget.value) }}
        />
      </div>
      <Button
        variant="primary"
        size="sm"
        disabled={busy || !ready}
        onClick={() => { void onSubmit(buildPlanDraft(cases, manualCases)) }}
      >
        {t('submitPlanDraft')}
      </Button>
    </section>
  )
}
