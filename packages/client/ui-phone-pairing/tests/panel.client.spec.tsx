// @vitest-environment jsdom
/**
 * The phone pairing section: the mint form and its result (QR, link, copy,
 * countdown, expiry), the phone-only view, the paired-session table with
 * refresh, and revocation behind the risk confirmation.
 */
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en } from '../src/client/locales.ts'
import { PhonePairingPanel } from '../src/client/PhonePairingPanel.tsx'
import type { PhonePairingPanelProps } from '../src/client/PhonePairingPanel.tsx'
import type { PairedSession, PairingApi } from '../src/client/api.ts'

afterEach(cleanup)

const t = makeTranslate(en)

const SESSIONS: PairedSession[] = [
  { sessionId: 's-phone', deviceLabel: 'my iphone', issuedAt: 1_700_000_000_000, expiresAt: 1_702_592_000_000 },
  { sessionId: 's-old', deviceLabel: 'old phone', issuedAt: 1_690_000_000_000, expiresAt: 1_692_592_000_000, revokedAt: 1_691_000_000_000 },
]

/** A scriptable api: every method records its calls and answers from the fields below. */
function scriptableApi(overrides: Partial<PairingApi> = {}): PairingApi & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    mint: async (input) => {
      calls.push(`mint:${input.deviceLabel}:${String(input.ttlMs)}`)
      return { authenticatedUrl: `https://dsh.example:8443/?token=${'A'.repeat(43)}`, expiresAt: 1_000_000 + 600_000 }
    },
    sessions: async () => {
      calls.push('sessions')
      return SESSIONS
    },
    revoke: async (sessionId) => {
      calls.push(`revoke:${sessionId}`)
    },
    ...overrides,
  }
}

function props(overrides: Partial<PhonePairingPanelProps> = {}): PhonePairingPanelProps {
  return { t, api: scriptableApi(), phone: false, now: () => 1_000_000, ...overrides }
}

describe('PhonePairingPanel', () => {
  it('lists the paired sessions on mount, with revoked rows marked and without a revoke button', async () => {
    const api = scriptableApi()
    const view = render(<PhonePairingPanel {...props({ api })} />)
    expect(view.getByText('Loading…')).toBeDefined()
    await vi.waitFor(() => { expect(view.getByText('my iphone')).toBeDefined() })
    expect(view.getByText('Active')).toBeDefined()
    expect(view.getByText('Revoked')).toBeDefined()
    expect(view.getByRole('button', { name: 'Revoke my iphone' })).toBeDefined()
    expect(view.queryByRole('button', { name: 'Revoke old phone' })).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'Refresh' }))
    await vi.waitFor(() => { expect(api.calls.filter(call => call === 'sessions')).toHaveLength(2) })
  })

  it('shows the empty and the failed states of the session list', async () => {
    const empty = render(<PhonePairingPanel {...props({ api: scriptableApi({ sessions: async () => [] }) })} />)
    await vi.waitFor(() => { expect(empty.getByText('No paired devices yet.')).toBeDefined() })
    cleanup()
    const failing = render(<PhonePairingPanel {...props({ api: scriptableApi({ sessions: async () => { throw new Error('HTTP 500') } }) })} />)
    await vi.waitFor(() => { expect(failing.getByRole('alert').textContent).toBe('Loading failed: HTTP 500') })
    cleanup()
    const nonError = render(<PhonePairingPanel {...props({ api: scriptableApi({ sessions: async () => { throw 'down' } }) })} />)
    await vi.waitFor(() => { expect(nonError.getByRole('alert').textContent).toBe('Loading failed: down') })
  })

  it('mints a link for a named device, renders the QR and the link, counts down, copies, and expires', async () => {
    vi.useFakeTimers()
    try {
      let clock = 1_000_000
      const api = scriptableApi()
      const clipboard = vi.fn(async () => true)
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: clipboard }, configurable: true })
      const view = render(<PhonePairingPanel {...props({ api, now: () => clock })} />)
      const mint = view.getByRole('button', { name: 'Mint pairing link' })
      expect(mint.hasAttribute('disabled')).toBe(true)
      fireEvent.change(view.getByPlaceholderText('e.g. My iPhone'), { target: { value: '  my iphone  ' } })
      fireEvent.change(view.getByRole('combobox'), { target: { value: '5' } })
      expect(mint.hasAttribute('disabled')).toBe(false)
      fireEvent.click(mint)
      await vi.waitFor(() => { expect(view.getByRole('region', { name: 'Scan to sign in' })).toBeDefined() })
      expect(api.calls).toContain('mint:my iphone:300000')
      expect(view.getByRole('img', { name: 'Pairing QR code' })).toBeDefined()
      expect(view.getByText(`https://dsh.example:8443/?token=${'A'.repeat(43)}`)).toBeDefined()
      expect(view.getByText('Expires in 600 s')).toBeDefined()
      fireEvent.click(view.getByRole('button', { name: 'Copy link' }))
      await vi.waitFor(() => { expect(view.getByText('Copied')).toBeDefined() })
      expect(clipboard).toHaveBeenCalledWith(`https://dsh.example:8443/?token=${'A'.repeat(43)}`)
      // The countdown follows the injected clock on every tick.
      clock += 100_000
      await vi.advanceTimersByTimeAsync(1000)
      expect(view.getByText('Expires in 500 s')).toBeDefined()
      clock += 600_000
      await vi.advanceTimersByTimeAsync(1000)
      expect(view.getByText('This link has expired; mint a new one.')).toBeDefined()
      expect(view.queryByRole('img', { name: 'Pairing QR code' })).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows the link and the copy button without a QR when the URL exceeds the encoder capacity', async () => {
    const long = `https://${'relay-'.repeat(30)}example:8443/?token=${'A'.repeat(43)}`
    const api = scriptableApi({ mint: async () => ({ authenticatedUrl: long, expiresAt: 2_000_000 }) })
    const view = render(<PhonePairingPanel {...props({ api })} />)
    fireEvent.change(view.getByPlaceholderText('e.g. My iPhone'), { target: { value: 'phone' } })
    fireEvent.click(view.getByRole('button', { name: 'Mint pairing link' }))
    await vi.waitFor(() => { expect(view.getByText(long)).toBeDefined() })
    expect(view.queryByRole('img', { name: 'Pairing QR code' })).toBeNull()
    expect(view.getByRole('button', { name: 'Copy link' })).toBeDefined()
  })

  it('reports a copy failure and a mint failure, and drops the previous link on a failed mint', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    let fail = false
    const api = scriptableApi({
      mint: async (input) => {
        if (fail) throw new Error('connection: pairing links are minted from the stable host only')
        return { authenticatedUrl: `https://dsh.example/?token=${input.deviceLabel}`, expiresAt: 2_000_000 }
      },
    })
    const view = render(<PhonePairingPanel {...props({ api })} />)
    fireEvent.change(view.getByPlaceholderText('e.g. My iPhone'), { target: { value: 'phone' } })
    fireEvent.submit(view.getByRole('button', { name: 'Mint pairing link' }).closest('form')!)
    await vi.waitFor(() => { expect(view.getByText('https://dsh.example/?token=phone')).toBeDefined() })
    fireEvent.click(view.getByRole('button', { name: 'Copy link' }))
    await vi.waitFor(() => { expect(view.getByText('Copy failed; select the link and copy it by hand.')).toBeDefined() })
    fail = true
    fireEvent.click(view.getByRole('button', { name: 'Mint pairing link' }))
    await vi.waitFor(() => { expect(view.getByRole('alert').textContent).toBe('Minting failed: connection: pairing links are minted from the stable host only') })
    expect(view.queryByText('https://dsh.example/?token=phone')).toBeNull()
    // A thrown non-Error is reported by its string form.
    const thrown = scriptableApi({ mint: async () => { throw 'nope' } })
    cleanup()
    const again = render(<PhonePairingPanel {...props({ api: thrown })} />)
    fireEvent.change(again.getByPlaceholderText('e.g. My iPhone'), { target: { value: 'phone' } })
    fireEvent.click(again.getByRole('button', { name: 'Mint pairing link' }))
    await vi.waitFor(() => { expect(again.getByRole('alert').textContent).toBe('Minting failed: nope') })
  })

  it('hides the mint form on a phone and still lists the sessions', async () => {
    const view = render(<PhonePairingPanel {...props({ phone: true })} />)
    expect(view.getByText('Pairing links are minted on the computer that runs the stable version', { exact: false })).toBeDefined()
    expect(view.queryByRole('button', { name: 'Mint pairing link' })).toBeNull()
    await vi.waitFor(() => { expect(view.getByText('my iphone')).toBeDefined() })
  })

  it('revokes a session only after the acknowledged confirmation, then reloads the list', async () => {
    const api = scriptableApi()
    const view = render(<PhonePairingPanel {...props({ api })} />)
    await vi.waitFor(() => { expect(view.getByRole('button', { name: 'Revoke my iphone' })).toBeDefined() })
    fireEvent.click(view.getByRole('button', { name: 'Revoke my iphone' }))
    const dialog = view.getByRole('dialog')
    expect(dialog.textContent).toContain('Device my iphone is signed out at once')
    // Cancel closes without a call.
    fireEvent.click(view.getByRole('button', { name: 'Cancel' }))
    await vi.waitFor(() => { expect(view.queryByRole('dialog')).toBeNull() })
    expect(api.calls.some(call => call.startsWith('revoke:'))).toBe(false)
    fireEvent.click(view.getByRole('button', { name: 'Revoke my iphone' }))
    fireEvent.click(view.getByLabelText('I understand, revoke now'))
    fireEvent.click(view.getByRole('button', { name: 'Revoke' }))
    await vi.waitFor(() => { expect(api.calls).toContain('revoke:s-phone') })
    await vi.waitFor(() => { expect(view.queryByRole('dialog')).toBeNull() })
    expect(api.calls.filter(call => call === 'sessions')).toHaveLength(2)
  })

  it('reports a failed revocation inside the flow and keeps the dialog for another try', async () => {
    const api = scriptableApi({ revoke: async () => { throw new Error('HTTP 500') } })
    const view = render(<PhonePairingPanel {...props({ api })} />)
    await vi.waitFor(() => { expect(view.getByRole('button', { name: 'Revoke my iphone' })).toBeDefined() })
    fireEvent.click(view.getByRole('button', { name: 'Revoke my iphone' }))
    fireEvent.click(view.getByLabelText('I understand, revoke now'))
    fireEvent.click(view.getByRole('button', { name: 'Revoke' }))
    await vi.waitFor(() => { expect(view.getByText('Revoking failed: HTTP 500')).toBeDefined() })
    expect(view.getByRole('dialog')).toBeDefined()
    cleanup()
    const thrown = scriptableApi({ revoke: async () => { throw 'gone' } })
    const again = render(<PhonePairingPanel {...props({ api: thrown })} />)
    await vi.waitFor(() => { expect(again.getByRole('button', { name: 'Revoke my iphone' })).toBeDefined() })
    fireEvent.click(again.getByRole('button', { name: 'Revoke my iphone' }))
    fireEvent.click(again.getByLabelText('I understand, revoke now'))
    fireEvent.click(again.getByRole('button', { name: 'Revoke' }))
    await vi.waitFor(() => { expect(again.getByText('Revoking failed: gone')).toBeDefined() })
  })
})
