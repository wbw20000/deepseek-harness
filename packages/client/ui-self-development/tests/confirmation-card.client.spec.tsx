// @vitest-environment jsdom
/** The confirmation card renders the facade's fixed wording verbatim. */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en } from '../src/client/locales.ts'
import { ConfirmationCard } from '../src/client/ConfirmationCard.tsx'
import { card, omit } from './fixtures.client.ts'

afterEach(cleanup)

describe('ConfirmationCard', () => {
  it('renders every card field, including the facade\'s fixed refusal wording', () => {
    const view = render(<ConfirmationCard t={makeTranslate(en)} card={card()} />)
    expect(view.getByRole('region', { name: 'Confirmation card' })).toBeDefined()
    expect(view.getByText('为导出菜单补充一个批量导出入口')).toBeDefined()
    expect(view.getByText('无依据')).toBeDefined()
    expect(view.getByText('未知，不放行')).toBeDefined()
    expect(view.getByText('a'.repeat(64))).toBeDefined()
    expect(view.getByText('apps/web/src/**')).toBeDefined()
    expect(view.getByText('Authorized')).toBeDefined()
    expect(view.getByText('Rounds and time')).toBeDefined()
    expect(view.getByText('Maximum rounds: 4')).toBeDefined()
    expect(view.getByText('Maximum time (ms): 600000')).toBeDefined()
    expect(view.getByText('Phase timeout (ms): (not set)')).toBeDefined()
    expect(view.getByText('Steps per attempt: (not set)')).toBeDefined()
    expect(view.getByText('No-progress attempt limit: (not set)')).toBeDefined()
    expect(view.getByText('Consumed rounds: 1 · Consumed time (ms): 90000')).toBeDefined()
    expect(view.getByText('case-1')).toBeDefined()
    expect(view.getByText('导出按钮点击后生成文件')).toBeDefined()
    expect(view.getByText('Assertions: assert-1')).toBeDefined()
    expect(view.getByText('深色模式下核对图标对比度')).toBeDefined()
  })

  it('renders every set budget limit', () => {
    const full = card({
      budget: { mode: 'both', maxRounds: 4, durationMs: 600000, phaseTimeoutMs: 120000, maxStepsPerAttempt: 40, noProgressAttemptLimit: 2 },
    })
    const view = render(<ConfirmationCard t={makeTranslate(en)} card={full} />)
    expect(view.getByText('Phase timeout (ms): 120000')).toBeDefined()
    expect(view.getByText('Steps per attempt: 40')).toBeDefined()
    expect(view.getByText('No-progress attempt limit: 2')).toBeDefined()
  })

  it('renders the unset label for absent terms and omits the empty case lists', () => {
    const empty = omit(card({
      taskAndGoal: '',
      planningAuthorized: false,
      budget: {},
      acceptanceCases: [],
      manualCases: [],
      allowedModificationScope: [],
    }), ['stableBaselineDigest'])
    const view = render(<ConfirmationCard t={makeTranslate(en)} card={empty} />)
    expect(view.getByText('Not authorized')).toBeDefined()
    expect(view.getByText('(not set)')).toBeDefined()
    expect(view.queryByText('Acceptance (automated cases)')).toBeNull()
    expect(view.queryByText('Acceptance (manual items)')).toBeNull()
  })
})
