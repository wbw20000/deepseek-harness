/**
 * The new-task form: one human-written spec plus an optional launch profile,
 * rendered above the task list. The creator field is prefilled from the last
 * submission in this browser and remembered on submit; the facade's wire
 * schema re-validates the spec and the digest at the boundary.
 */
import { useState, type ReactNode } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TaskSpecInput } from '@deepseek-ai/dsh-workflow-self-development-remote'
import type { LaunchProfileInput } from './wire.ts'
import { buildCreateTaskSpec, buildLaunchProfileInput } from './wire.ts'
import type { Translate } from './status.ts'
import css from './SelfDevelopmentPanel.module.css'

/** localStorage key remembering the last creator across panel mounts. */
export const CREATED_BY_STORAGE_KEY = 'dsh-self-dev-created-by'

/** Props of the new-task form: the dictionary seat and the create callback. */
export interface NewTaskFormProps {
  /** The dictionary seat. */
  readonly t: Translate
  /** Whether another operation is in flight; disables the submit button. */
  readonly busy: boolean
  /** Create the task; the profile argument is absent when the form left it empty. */
  readonly onCreate: (spec: TaskSpecInput, profile: LaunchProfileInput | undefined) => Promise<void>
}

/**
 * Render the new-task form.
 * @param props - the dictionary seat, the busy flag, and the create callback.
 * @returns the form element tree.
 */
export function NewTaskForm(props: NewTaskFormProps): ReactNode {
  const { t, busy, onCreate } = props
  const [taskId, setTaskId] = useState('')
  const [requirement, setRequirement] = useState('')
  const [scope, setScope] = useState('')
  const [baseline, setBaseline] = useState('')
  const [createdBy, setCreatedBy] = useState(() => localStorage.getItem(CREATED_BY_STORAGE_KEY) ?? '')
  const [profileWorktree, setProfileWorktree] = useState('')
  const [profileAcceptance, setProfileAcceptance] = useState('')
  const [profileArtifacts, setProfileArtifacts] = useState('')

  const ready = taskId.trim() !== '' && requirement.trim() !== '' && scope.trim() !== ''
    && baseline.trim() !== '' && createdBy.trim() !== ''

  const submit = async (): Promise<void> => {
    /* v8 ignore next 2 -- the submit button is disabled until the form is complete. */
    if (!ready) return
    localStorage.setItem(CREATED_BY_STORAGE_KEY, createdBy.trim())
    const profile = buildLaunchProfileInput({
      worktree: profileWorktree, acceptancePath: profileAcceptance, artifactPaths: profileArtifacts,
    })
    await onCreate(buildCreateTaskSpec({ taskId, requirement, scope, baseline, createdBy }), profile)
  }

  return (
    <section className={css.form} aria-label={t('newTaskTitle')}>
      <div className={css.formRow}>
        <label className={css.formLabel} htmlFor="dsh-self-dev-new-task-id">{t('newTaskId')}</label>
        <Input
          id="dsh-self-dev-new-task-id"
          value={taskId}
          onChange={(event) => { setTaskId(event.currentTarget.value) }}
        />
      </div>
      <div className={css.formRow}>
        <label className={css.formLabel} htmlFor="dsh-self-dev-new-requirement">{t('formRequirement')}</label>
        <Input
          id="dsh-self-dev-new-requirement"
          value={requirement}
          onChange={(event) => { setRequirement(event.currentTarget.value) }}
        />
      </div>
      <div className={css.formRow}>
        <label className={css.formLabel} htmlFor="dsh-self-dev-new-scope">{t('formScope')}</label>
        <Input
          id="dsh-self-dev-new-scope"
          value={scope}
          onChange={(event) => { setScope(event.currentTarget.value) }}
        />
      </div>
      <div className={css.formRow}>
        <label className={css.formLabel} htmlFor="dsh-self-dev-new-baseline">{t('formBaseline')}</label>
        <Input
          id="dsh-self-dev-new-baseline"
          value={baseline}
          onChange={(event) => { setBaseline(event.currentTarget.value) }}
        />
        <span className={css.echo}>{t('baselineHint')}</span>
      </div>
      <div className={css.formRow}>
        <label className={css.formLabel} htmlFor="dsh-self-dev-new-created-by">{t('formCreatedBy')}</label>
        <Input
          id="dsh-self-dev-new-created-by"
          value={createdBy}
          onChange={(event) => { setCreatedBy(event.currentTarget.value) }}
        />
      </div>
      <div className={css.formRow}>
        <span className={css.formLabel}>{t('newTaskProfileTitle')}</span>
      </div>
      <div className={css.formRow}>
        <label className={css.formLabel} htmlFor="dsh-self-dev-new-profile-worktree">{t('formWorktree')}</label>
        <Input
          id="dsh-self-dev-new-profile-worktree"
          value={profileWorktree}
          onChange={(event) => { setProfileWorktree(event.currentTarget.value) }}
        />
      </div>
      <div className={css.formRow}>
        <label className={css.formLabel} htmlFor="dsh-self-dev-new-profile-acceptance">{t('formAcceptancePath')}</label>
        <Input
          id="dsh-self-dev-new-profile-acceptance"
          value={profileAcceptance}
          onChange={(event) => { setProfileAcceptance(event.currentTarget.value) }}
        />
      </div>
      <div className={css.formRow}>
        <label className={css.formLabel} htmlFor="dsh-self-dev-new-profile-artifacts">{t('formArtifactPaths')}</label>
        <Input
          id="dsh-self-dev-new-profile-artifacts"
          value={profileArtifacts}
          onChange={(event) => { setProfileArtifacts(event.currentTarget.value) }}
        />
      </div>
      <Button
        variant="primary"
        size="sm"
        disabled={busy || !ready}
        onClick={() => { void submit() }}
      >
        {t('submitCreateTask')}
      </Button>
    </section>
  )
}
