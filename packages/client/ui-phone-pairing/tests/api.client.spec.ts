/**
 * The fetch port over Connection's session routes: request shapes, JSON
 * decoding, and the error carried from a non-2xx reply.
 */
import { describe, expect, it } from 'vitest'
import { fetchPairingApi, MINT_PATH, REVOKE_PATH, SESSIONS_PATH } from '../src/client/api.ts'

/** One recorded fetch call: the path, the init, and the body when it was a string. */
interface Call {
  input: string
  init?: RequestInit
  body?: string
}

/** A fetch recorder answering from a queue of responses. */
function recorder(responses: Response[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const impl: typeof fetch = async (input, init) => {
    const call: Call = { input: typeof input === 'string' ? input : 'non-string input' }
    if (init !== undefined) call.init = init
    if (typeof init?.body === 'string') call.body = init.body
    calls.push(call)
    const next = responses.shift()
    if (next === undefined) throw new Error('recorder: no response queued')
    return next
  }
  return { fetch: impl, calls }
}

describe('fetchPairingApi', () => {
  it('mints with the label and ttl as JSON and returns the minted link', async () => {
    const { fetch, calls } = recorder([Response.json({ authenticatedUrl: 'https://dsh.example/?token=t', expiresAt: 42 })])
    const api = fetchPairingApi(fetch)
    await expect(api.mint({ deviceLabel: 'phone', ttlMs: 600_000 })).resolves.toEqual({ authenticatedUrl: 'https://dsh.example/?token=t', expiresAt: 42 })
    expect(calls[0]?.input).toBe(MINT_PATH)
    expect(calls[0]?.init).toMatchObject({ method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' } })
    expect(JSON.parse(calls[0]?.body ?? '')).toEqual({ ttlMs: 600_000, deviceLabel: 'phone' })
  })

  it('lists sessions and revokes one', async () => {
    const sessions = [{ sessionId: 's1', deviceLabel: 'phone', issuedAt: 1, expiresAt: 2 }]
    const { fetch, calls } = recorder([Response.json({ sessions }), Response.json({ revoked: true })])
    const api = fetchPairingApi(fetch)
    await expect(api.sessions()).resolves.toEqual(sessions)
    expect(calls[0]).toEqual({ input: SESSIONS_PATH, init: { credentials: 'same-origin' } })
    await expect(api.revoke('s1')).resolves.toBeUndefined()
    expect(calls[1]?.input).toBe(REVOKE_PATH)
    expect(JSON.parse(calls[1]?.body ?? '')).toEqual({ sessionId: 's1' })
  })

  it('turns a non-2xx reply into an error carrying the server text, or the status when empty', async () => {
    const { fetch } = recorder([
      new Response('connection: pairing links are minted from the stable host only', { status: 403 }),
      new Response('', { status: 500 }),
    ])
    const api = fetchPairingApi(fetch)
    await expect(api.mint({ deviceLabel: 'x', ttlMs: 1 })).rejects.toThrow('stable host only')
    await expect(api.sessions()).rejects.toThrow('HTTP 500')
  })
})
