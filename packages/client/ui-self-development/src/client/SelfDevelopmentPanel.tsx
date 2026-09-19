/**
 * The self-development panel: task list, confirmation card, projection
 * summary, per-round evidence timeline, and the explicit authorization
 * actions. Both registered seats (the sidebar tab body and the Settings
 * section) render this one component with the same injected face. Every write
 * goes through its dialog confirmation; the run-attempt dialog's acknowledgement
 * checkbox is the only source of `presenceAcknowledged`, and the panel offers
 * no upgrade action because the facade has none.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Button, Checkbox, Input, RiskConfirmation, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { BudgetApproval } from '@deepseek-ai/dsh-workflow-self-development'
import type {
  RecentEvent, RemoteRunAttemptOutcome, TaskDetail, TaskSummary,
} from '@deepseek-ai/dsh-workflow-self-development-remote'
import { ConfirmationCard } from './ConfirmationCard.tsx'
import type { SelfDevelopmentAvailability, SelfDevelopmentInjected } from './face.ts'
import { RoundTimeline } from './RoundTimeline.tsx'
import {
  actionLabelKey,
  actionsFor,
  dialogDetailKey,
  dialogTitleKey,
  handoffReasonKey,
  statusKey,
  stopReasonKey,
} from './status.ts'
import type { ActionId } from './status.ts'
import { buildBudgetApproval, buildConfirmedPlan, buildRunAttemptRequest, failureText } from './wire.ts'
import css from './SelfDevelopmentPanel.module.css'

/** Composed props of the panel: the injected face plus the locale seat. */
export type SelfDevelopmentPanelProps =
  & InjectFace<SelfDevelopmentInjected>
  & PropsLocale<'selfDevelopment'>

/** Mutable text of the run-attempt form (one state object, one setter). */
interface RunFormState {
  confirmedBy: string
  worktree: string
  artifactPaths: string
  acceptancePath: string
  dataHome: string
  ports: string
  presence: boolean
}

/** Mutable text of the budget form. */
interface BudgetFormState {
  mode: BudgetApproval['mode']
  maxRounds: string
  durationMs: string
  phaseTimeoutMs: string
  maxStepsPerAttempt: string
  noProgressAttemptLimit: string
}

/** Initial run form: everything empty, presence never pre-selected. */
const EMPTY_RUN: RunFormState = {
  confirmedBy: '', worktree: '', artifactPaths: '', acceptancePath: '', dataHome: '', ports: '', presence: false,
}

/** Initial budget form: explicit mode, every limit unset until typed. */
const EMPTY_BUDGET: BudgetFormState = {
  mode: 'rounds', maxRounds: '', durationMs: '', phaseTimeoutMs: '', maxStepsPerAttempt: '', noProgressAttemptLimit: '',
}

/** The budget form's numeric fields, in display order. */
const BUDGET_FIELDS = [
  ['maxRounds', 'formMaxRounds'],
  ['durationMs', 'formDurationMs'],
  ['phaseTimeoutMs', 'formPhaseTimeoutMs'],
  ['maxStepsPerAttempt', 'formMaxStepsPerAttempt'],
  ['noProgressAttemptLimit', 'formNoProgressAttemptLimit'],
] as const

/**
 * Render the panel.
 * @param props - the injected face and the dictionary seat.
 * @returns the panel element tree.
 */
export function SelfDevelopmentPanel(props: SelfDevelopmentPanelProps): ReactNode {
  const { t, remote, phone, useAvailability } = props
  const availability: SelfDevelopmentAvailability = useAvailability(fact => fact)
  const api = availability.remote ? remote : undefined

  const [tasks, setTasks] = useState<readonly TaskSummary[] | undefined>(undefined)
  const [listError, setListError] = useState<string | undefined>(undefined)
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
  const [detail, setDetail] = useState<TaskDetail | undefined>(undefined)
  const [detailError, setDetailError] = useState<string | undefined>(undefined)
  const [timeline, setTimeline] = useState<readonly RecentEvent[]>([])
  const [busy, setBusy] = useState(false)
  const [opError, setOpError] = useState<string | undefined>(undefined)
  const [dialog, setDialog] = useState<ActionId | undefined>(undefined)
  const [acknowledged, setAcknowledged] = useState(false)
  const [run, setRun] = useState<RunFormState>(EMPTY_RUN)
  const [budget, setBudget] = useState<BudgetFormState>(EMPTY_BUDGET)
  const [trial, setTrial] = useState<RemoteRunAttemptOutcome | undefined>(undefined)
  const [copied, setCopied] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    if (api === undefined) return
    const result = await api.listTasks()
    if (!result.ok) {
      setListError(failureText(t, result.error))
      return
    }
    setListError(undefined)
    setTasks(result.value)
    const events = await api.recentEvents()
    if (events.ok) setTimeline(events.value)
  }, [api, t])

  useEffect(() => { void refresh() }, [refresh])

  const openTask = useCallback(async (taskId: string): Promise<void> => {
    setSelectedId(taskId)
    setDetail(undefined)
    setDetailError(undefined)
    /* v8 ignore next -- the list renders only with the remote face mounted; the guard covers a stale closure after availability flips. */
    if (api === undefined) return
    const result = await api.getTask(taskId)
    if (!result.ok) {
      setDetailError(failureText(t, result.error))
      return
    }
    setDetail(result.value)
  }, [api, t])

  /** Run one mutating operation, then resync the list and the open detail. */
  const execute = async (
    operation: () => Promise<{ ok: true } | { ok: false; error: { code: string; message: string } }>,
  ): Promise<void> => {
    // Only the dialog's confirm path calls this, so the open task and its
    // loaded detail are always in place.
    /* v8 ignore next 2 -- the dialog confirm path guarantees both operands. */
    if (selectedId === undefined || detail === undefined) return
    setBusy(true)
    try {
      const result = await operation()
      if (!result.ok) {
        setOpError(failureText(t, result.error))
        return
      }
      setOpError(undefined)
      await refresh()
      await openTask(selectedId)
    } finally {
      setBusy(false)
    }
  }

  const closeDialog = (): void => {
    setDialog(undefined)
    setAcknowledged(false)
  }

  const confirmDialog = (): void => {
    // RiskConfirmation invokes onConfirm only while its dialog is open, and an
    // open dialog always sits on a selected, loaded task.
    /* v8 ignore next 2 -- the open-dialog path guarantees every operand. */
    if (dialog === undefined || selectedId === undefined || detail === undefined || api === undefined) return
    const actor = run.confirmedBy.trim()
    const revision = detail.projection.revision
    const requested = dialog
    const plan = detail.projection.plan
    if (requested === 'authorizePlanning') {
      closeDialog()
      void execute(() => api.authorizePlanning(selectedId, revision, actor))
    } else if (requested === 'confirmPlan') {
      closeDialog()
      /* v8 ignore next 2 -- the confirm action renders only when a plan view exists. */
      if (plan === undefined) return
      void execute(() => api.confirmPlan(selectedId, revision, buildConfirmedPlan(plan), actor))
    } else if (requested === 'approveBudget') {
      const spec = detail.projection.spec
      if (plan === undefined || spec === undefined) {
        closeDialog()
        setOpError(t('budgetBasisMissing'))
        return
      }
      closeDialog()
      const approval = buildBudgetApproval(budget, plan.version, spec.version, actor)
      void execute(() => api.approveBudget(selectedId, revision, approval))
    } else if (requested === 'runAttempt') {
      // RiskConfirmation enables its confirm button only when its
      // acknowledgement checkbox is checked, so the request built here always
      // carries `presenceAcknowledged: true`; the facade re-refuses anything
      // else at the wire boundary.
      const request = buildRunAttemptRequest(selectedId, revision, run, phone, acknowledged)
      closeDialog()
      setBusy(true)
      void (async () => {
        try {
          const result = await api.runAttempt(request)
          if (!result.ok) {
            setOpError(failureText(t, result.error))
            return
          }
          setOpError(undefined)
          setTrial(result.value)
          await refresh()
          await openTask(selectedId)
        } finally {
          setBusy(false)
        }
      })()
    } else if (requested === 'stop') {
      closeDialog()
      void execute(() => api.stop(selectedId, revision, 'cancelled'))
    } else {
      closeDialog()
      void execute(() => api.recordTrialApproval(selectedId, revision, actor))
    }
  }

  if (api === undefined) {
    return (
      <div className={css.panel} data-enabled="false">
        <h2 className={css.heading}>{t('title')}</h2>
        <p className={css.statusLine}>{t('notEnabled')}</p>
        <p className={css.statusLine}>{t('notEnabledDetail')}</p>
      </div>
    )
  }

  const actor = run.confirmedBy.trim()
  const available = detail === undefined ? [] : actionsFor(
    detail.projection.status,
    detail.projection.plan !== undefined,
    detail.projection.verifiedResultDigest !== undefined,
  )
  const runReady = run.presence && actor !== '' && run.worktree.trim() !== ''
    && run.acceptancePath.trim() !== '' && run.artifactPaths.trim() !== ''

  /** Copy one experiment path; a path only exists after a launched attempt reported one. */
  const copyPath = async (path: string | undefined): Promise<void> => {
    if (path === undefined) return
    setCopied(await writeClipboard(path))
  }

  return (
    <div className={css.panel} data-enabled="true" data-phone={phone ? 'true' : undefined}>
      <header className={css.header}>
        <h2 className={css.heading}>{t('title')}</h2>
        <Button size="sm" onClick={() => { void refresh() }}>{t('reload')}</Button>
      </header>
      <ul className={css.taskList} aria-label={t('listLabel')}>
        {(tasks ?? []).map(task => (
          <li key={task.taskId} className={css.taskRow}>
            <Button
              variant={task.taskId === selectedId ? 'primary' : 'outline'}
              size="sm"
              className={css.taskButton}
              aria-label={t('selectTask', { taskId: task.taskId })}
              onClick={() => { void openTask(task.taskId) }}
            >
              <span className={css.taskTitle}>{task.title === '' ? task.taskId : task.title}</span>
              <span className={css.taskBadge}>{t(statusKey(task.status))}</span>
              <span className={css.taskRevision}>{`${t('columnRevision')} ${task.revision}`}</span>
            </Button>
          </li>
        ))}
      </ul>
      {tasks === undefined ? <p className={css.statusLine}>{t('loading')}</p> : null}
      {tasks !== undefined && tasks.length === 0 ? <p className={css.statusLine}>{t('listEmpty')}</p> : null}
      {listError !== undefined ? <p className={css.errorLine}>{listError}</p> : null}
      {detailError !== undefined ? <p className={css.errorLine}>{detailError}</p> : null}
      {detail === undefined
        ? null
        : (
          <>
            <ConfirmationCard t={t} card={detail.card} />
            <section className={css.projection} aria-label={t('projectionTitle')}>
              <h3 className={css.cardHeading}>{t('projectionTitle')}</h3>
              <p className={css.fieldRow}>
                {`${t('projectionRevision')}: ${detail.projection.revision} · ${t(statusKey(detail.projection.status))}`}
              </p>
              {detail.projection.currentAttempt === undefined
                ? null
                : (
                  <p className={css.fieldRow}>
                    {`${t('projectionCurrentAttempt')}: ${t('attemptNumber', { n: detail.projection.currentAttempt.attemptNumber })}`}
                  </p>
                )}
              {detail.projection.verifiedResultDigest === undefined
                ? null
                : <p className={css.fieldRow}>{`${t('projectionVerifiedDigest')}: ${detail.projection.verifiedResultDigest}`}</p>}
              {detail.projection.stopReason === undefined
                ? null
                : <p className={css.fieldRow}>{`${t('projectionStopReason')}: ${t(stopReasonKey(detail.projection.stopReason))}`}</p>}
              {detail.projection.handoffReason === undefined
                ? null
                : (
                  <>
                    <p className={css.fieldRow}>
                      {`${t('projectionHandoff')}: ${t(handoffReasonKey(detail.projection.handoffReason))}`}
                    </p>
                    {detail.projection.handoffDetail === undefined
                      ? null
                      : <p className={css.fieldRow}>{`${t('projectionHandoffDetail')}: ${detail.projection.handoffDetail}`}</p>}
                  </>
                )}
              {detail.projection.trialApproval === undefined
                ? null
                : (
                  <p className={css.fieldRow}>
                    {t('trialApprovedBy', { approvedBy: detail.projection.trialApproval.approvedBy })}
                  </p>
                )}
            </section>
            <div className={css.formRow}>
              <label className={css.formLabel} htmlFor="dsh-self-dev-actor">{t('formConfirmedBy')}</label>
              <Input
                id="dsh-self-dev-actor"
                value={run.confirmedBy}
                placeholder={t('formConfirmedByPlaceholder')}
                onChange={(event) => { setRun({ ...run, confirmedBy: event.currentTarget.value }) }}
              />
            </div>
            <div className={css.actions}>
              {available.map(action => (
                <Button
                  key={action}
                  variant="primary"
                  size="sm"
                  disabled={busy || (action !== 'stop' && actor === '')}
                  onClick={() => { setDialog(action) }}
                >
                  {t(actionLabelKey(action))}
                </Button>
              ))}
            </div>
            {opError !== undefined ? <p className={css.errorLine}>{opError}</p> : null}
            {available.includes('runAttempt')
              ? (
                <section className={css.form} aria-label={t('actionStartAttempt')}>
                  <div className={css.formRow}>
                    <label className={css.formLabel} htmlFor="dsh-self-dev-worktree">{t('formWorktree')}</label>
                    <Input
                      id="dsh-self-dev-worktree"
                      value={run.worktree}
                      onChange={(event) => { setRun({ ...run, worktree: event.currentTarget.value }) }}
                    />
                    <span className={css.echo}>{t('echo', { value: run.worktree })}</span>
                  </div>
                  <div className={css.formRow}>
                    <label className={css.formLabel} htmlFor="dsh-self-dev-artifacts">{t('formArtifactPaths')}</label>
                    <Input
                      id="dsh-self-dev-artifacts"
                      value={run.artifactPaths}
                      onChange={(event) => { setRun({ ...run, artifactPaths: event.currentTarget.value }) }}
                    />
                  </div>
                  <div className={css.formRow}>
                    <label className={css.formLabel} htmlFor="dsh-self-dev-acceptance">{t('formAcceptancePath')}</label>
                    <Input
                      id="dsh-self-dev-acceptance"
                      value={run.acceptancePath}
                      onChange={(event) => { setRun({ ...run, acceptancePath: event.currentTarget.value }) }}
                    />
                  </div>
                  <div className={css.formRow}>
                    <label className={css.formLabel} htmlFor="dsh-self-dev-datahome">{t('formDataHome')}</label>
                    <Input
                      id="dsh-self-dev-datahome"
                      value={run.dataHome}
                      disabled={phone}
                      onChange={(event) => { setRun({ ...run, dataHome: event.currentTarget.value }) }}
                    />
                    <span className={css.echo}>
                      {t('echo', { value: run.dataHome === '' ? t('unset') : run.dataHome })}
                    </span>
                  </div>
                  <div className={css.formRow}>
                    <label className={css.formLabel} htmlFor="dsh-self-dev-ports">{t('formPorts')}</label>
                    <Input
                      id="dsh-self-dev-ports"
                      value={run.ports}
                      onChange={(event) => { setRun({ ...run, ports: event.currentTarget.value }) }}
                    />
                  </div>
                  <Checkbox
                    checked={run.presence}
                    label={t('presenceLabel')}
                    onChange={(next) => { setRun({ ...run, presence: next }) }}
                  />
                  {!runReady ? <p className={css.statusLine}>{t('presenceRequired')}</p> : null}
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={!runReady || busy}
                    onClick={() => { setDialog('runAttempt') }}
                  >
                    {t('submitForm')}
                  </Button>
                </section>
              )
              : null}
            {available.includes('approveBudget')
              ? (
                <section className={css.form} aria-label={t('actionApproveBudget')}>
                  <div className={css.formRow}>
                    <label className={css.formLabel} htmlFor="dsh-self-dev-mode">{t('formMode')}</label>
                    <select
                      id="dsh-self-dev-mode"
                      value={budget.mode}
                      onChange={(event) => { setBudget({ ...budget, mode: event.currentTarget.value as BudgetApproval['mode'] }) }}
                    >
                      <option value="rounds">{t('budgetModeRounds')}</option>
                      <option value="time">{t('budgetModeTime')}</option>
                      <option value="both">{t('budgetModeBoth')}</option>
                    </select>
                  </div>
                  {BUDGET_FIELDS.map(([field, key]) => (
                    <div key={field} className={css.formRow}>
                      <label className={css.formLabel} htmlFor={`dsh-self-dev-${field}`}>{t(key)}</label>
                      <Input
                        id={`dsh-self-dev-${field}`}
                        type="number"
                        value={budget[field]}
                        onChange={(event) => { setBudget({ ...budget, [field]: event.currentTarget.value }) }}
                      />
                    </div>
                  ))}
                  <p className={css.fieldRow}>
                    {`${t('formPlanVersion')}: ${detail.projection.plan?.version ?? t('unset')} · ${t('formSpecVersion')}: ${detail.projection.spec?.version ?? t('unset')}`}
                  </p>
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={busy || actor === ''}
                    onClick={() => { setDialog('approveBudget') }}
                  >
                    {t('submitForm')}
                  </Button>
                </section>
              )
              : null}
          </>
        )}
      {detail === undefined
        ? null
        : (
          <section className={css.trial} aria-label={t('trialTitle')}>
            <h3 className={css.cardHeading}>{t('trialTitle')}</h3>
            {phone
              ? <p className={css.statusLine}>{t('trialHidden')}</p>
              : (
                <>
                  <p className={css.fieldRow}>{`${t('trialWorktree')}: ${trial?.worktree ?? t('unset')}`}</p>
                  {trial?.evidencePath === undefined ? null : <p className={css.fieldRow}>{`${t('trialEvidence')}: ${trial.evidencePath}`}</p>}
                  <div className={css.actions}>
                    <Button size="sm" onClick={() => { void copyPath(trial?.worktree) }}>
                      {t('trialCopy')}
                    </Button>
                    {copied ? <span className={css.echo}>{t('trialCopied')}</span> : null}
                  </div>
                </>
              )}
          </section>
        )}
      <RoundTimeline t={t} events={timeline} />
      <RiskConfirmation
        open={dialog !== undefined}
        title={dialog === undefined ? '' : t(dialogTitleKey(dialog))}
        description={dialog === undefined ? '' : t(dialogDetailKey(dialog))}
        acknowledgeLabel={dialog === 'runAttempt' ? t('presenceLabel') : t('dialogAcknowledge')}
        cancelLabel={t('dialogCancel')}
        closeLabel={t('dialogClose')}
        confirmLabel={t('dialogConfirm')}
        acknowledged={acknowledged}
        disabled={busy}
        onAcknowledgedChange={setAcknowledged}
        onCancel={closeDialog}
        onConfirm={confirmDialog}
      />
    </div>
  )
}
