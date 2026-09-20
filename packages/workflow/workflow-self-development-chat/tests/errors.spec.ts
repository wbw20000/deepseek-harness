/**
 * Normalization of a thrown facade/workspace error into the wire error view,
 * including the `details.code`-over-`.code` precedence for the remote
 * facade's `self-development/core` wrapping convention.
 * @module errors.spec
 */

import { describe, expect, it } from 'vitest'
import { errorOf } from '../src/errors.ts'

describe('errorOf', () => {
  it('prefers details.code over a top-level code', () => {
    const error = Object.assign(new Error('budget over ceiling'), {
      code: 'self-development/core',
      details: { code: 'SELF_DEV_BUDGET_INVALID' },
    })
    expect(errorOf(error)).toEqual({ code: 'SELF_DEV_BUDGET_INVALID', message: 'budget over ceiling' })
  })

  it('falls back to a top-level code when details.code is absent', () => {
    const error = Object.assign(new Error('chain locked'), { code: 'self-development/workspace-busy' })
    expect(errorOf(error)).toEqual({ code: 'self-development/workspace-busy', message: 'chain locked' })
  })

  it('omits code entirely for a plain Error', () => {
    expect(errorOf(new Error('boom'))).toEqual({ message: 'boom' })
  })

  it('ignores a non-string code or details.code', () => {
    const error = Object.assign(new Error('weird'), { code: 42, details: { code: {} } })
    expect(errorOf(error)).toEqual({ message: 'weird' })
  })

  it('stringifies a thrown value with no message', () => {
    expect(errorOf('not an error')).toEqual({ message: 'not an error' })
    expect(errorOf(undefined)).toEqual({ message: 'undefined' })
  })
})
