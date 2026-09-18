/** Session deep links: startup route consumption and the native-shell bridge. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { BridgeWindow, SessionBridge } from '../src/client/deep-link.ts'
import {
  isSessionDeepLinkId, parseSessionDeepLink, startSessionDeepLink,
} from '../src/client/deep-link.ts'

const sid = (id: string): ReturnType<typeof SessionId> => SessionId(id)

class MutableSource<T> {
  private readonly listeners = new Set<() => void>()

  constructor(private value: T) {}

  getSnapshot(): T {
    return this.value
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  set(value: T): void {
    this.value = value
    for (const listener of [...this.listeners]) listener()
  }
}

function sessionState(
  ids: readonly string[],
  phase: SessionListState['phase'] = 'ready',
): SessionListState {
  return {
    ids: ids.map(sid),
    byId: Object.fromEntries(ids.map(id => [id, {
      id: sid(id), displayTitle: id, running: false, blank: false, updatedAt: 0, retainedBy: {},
    }])),
    phase,
    subagentsByParent: {},
    jobsBySession: {},
  }
}

interface BenchOptions {
  /** Startup document path. */
  readonly pathname?: string
  /** Initial Session-list snapshot. */
  readonly sessions?: SessionListState
  /** Selection replacement, defaulting to a recorder. */
  readonly openSession?: (id: ReturnType<typeof SessionId>) => void
}

function bench(options: BenchOptions = {}) {
  const list = new MutableSource(options.sessions ?? sessionState([], 'pending'))
  const openSession = vi.fn(options.openSession ?? (() => undefined))
  const reportMissing = vi.fn()
  const replacePath = vi.fn()
  const target: BridgeWindow = {}
  const stop = startSessionDeepLink(
    { sessions: { list }, openSession, reportMissing },
    { pathname: options.pathname, replacePath },
    target,
  )
  return { list, openSession, reportMissing, replacePath, target, stop }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('parseSessionDeepLink', () => {
  it('accepts deep-link paths within the id form', () => {
    expect(parseSessionDeepLink('/session/a')).toBe(sid('a'))
    expect(parseSessionDeepLink('/session/Abc.123_x-y')).toBe(sid('Abc.123_x-y'))
    expect(parseSessionDeepLink(`/session/${'i'.repeat(128)}`)).toBe(sid('i'.repeat(128)))
  })

  it('rejects every other path shape', () => {
    for (const pathname of [
      '', '/', '/session', '/session/', '/sessions/a', '/session/a/b', '/session/a b',
      `/session/${'i'.repeat(129)}`, '/session/a?token=x', '//session/a',
    ]) {
      expect(parseSessionDeepLink(pathname)).toBeUndefined()
    }
  })

  it('accepts purely by the lexical id form, so dot segments stay id candidates', () => {
    // Acceptance is lexical only: the ready Session list decides existence.
    expect(parseSessionDeepLink('/session/..')).toBe(sid('..'))
  })
})

describe('isSessionDeepLinkId', () => {
  it('bounds the id form the bridge accepts', () => {
    expect(isSessionDeepLinkId('a')).toBe(true)
    expect(isSessionDeepLinkId('a.b-c_d')).toBe(true)
    expect(isSessionDeepLinkId('a'.repeat(128))).toBe(true)
    expect(isSessionDeepLinkId('a'.repeat(129))).toBe(false)
    expect(isSessionDeepLinkId('')).toBe(false)
    expect(isSessionDeepLinkId('a/b')).toBe(false)
  })
})

describe('startSessionDeepLink startup route', () => {
  it('selects the deep-linked session once the Session list is ready', () => {
    const b = bench({ pathname: '/session/alpha' })
    expect(b.openSession).not.toHaveBeenCalled()
    expect(b.replacePath).not.toHaveBeenCalled()
    b.list.set(sessionState(['alpha']))
    expect(b.openSession).toHaveBeenCalledExactlyOnceWith(sid('alpha'))
    expect(b.replacePath).toHaveBeenCalledExactlyOnceWith('/')
    expect(b.reportMissing).not.toHaveBeenCalled()
  })

  it('selects immediately when the list is already ready at startup', () => {
    const b = bench({ pathname: '/session/alpha', sessions: sessionState(['alpha']) })
    expect(b.openSession).toHaveBeenCalledExactlyOnceWith(sid('alpha'))
    expect(b.replacePath).toHaveBeenCalledExactlyOnceWith('/')
  })

  it('reports a missing session, cleans the address, and selects nothing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const b = bench({ pathname: '/session/ghost', sessions: sessionState(['alpha']) })
    expect(b.openSession).not.toHaveBeenCalled()
    expect(b.reportMissing).toHaveBeenCalledExactlyOnceWith(sid('ghost'))
    expect(b.replacePath).toHaveBeenCalledExactlyOnceWith('/')
    expect(warn).toHaveBeenCalledWith('session deep link: the Session list has no session ghost')
  })

  it('consumes the startup link once and ignores later list updates', () => {
    const b = bench({ pathname: '/session/alpha' })
    b.list.set(sessionState(['alpha']))
    b.list.set(sessionState(['alpha', 'beta']))
    expect(b.openSession).toHaveBeenCalledExactlyOnceWith(sid('alpha'))
    expect(b.replacePath).toHaveBeenCalledExactlyOnceWith('/')
  })

  it('does nothing at startup without a deep-link path', () => {
    const b = bench({ pathname: '/', sessions: sessionState(['alpha']) })
    expect(b.openSession).not.toHaveBeenCalled()
    expect(b.replacePath).not.toHaveBeenCalled()
    expect(b.target.__DSH_BRIDGE__).toBeDefined()
  })

  it('keeps a failing selection non-fatal and routes it to the notice', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failure = new Error('retain failed')
    const b = bench({ pathname: '/session/alpha', sessions: sessionState(['alpha']), openSession: () => { throw failure } })
    expect(b.reportMissing).toHaveBeenCalledExactlyOnceWith(sid('alpha'))
    expect(b.replacePath).toHaveBeenCalledExactlyOnceWith('/')
    expect(warn).toHaveBeenCalledWith('session deep link: selecting session alpha failed:', failure)
    await expect(b.target.__DSH_BRIDGE__!.selectSession('alpha')).resolves.toBe(false)
  })

  it('stops consuming after disposal', () => {
    const b = bench({ pathname: '/session/alpha' })
    b.stop()
    b.list.set(sessionState(['alpha']))
    expect(b.openSession).not.toHaveBeenCalled()
    expect(b.replacePath).not.toHaveBeenCalled()
    expect(b.target.__DSH_BRIDGE__).toBeUndefined()
  })

  it('leaves a foreign bridge global in place on disposal', () => {
    const b = bench({ pathname: '/session/alpha' })
    const foreign: SessionBridge = { selectSession: () => Promise.resolve(true) }
    b.target.__DSH_BRIDGE__ = foreign
    b.stop()
    expect(b.target.__DSH_BRIDGE__).toBe(foreign)
  })

  it('reads the real document path and rewrites history by default', () => {
    const replaceState = vi.fn()
    vi.stubGlobal('location', { pathname: '/session/alpha' })
    vi.stubGlobal('history', { replaceState })
    const list = new MutableSource(sessionState(['alpha']))
    const openSession = vi.fn()
    const stop = startSessionDeepLink({ sessions: { list }, openSession, reportMissing: () => {} })
    expect(openSession).toHaveBeenCalledExactlyOnceWith(sid('alpha'))
    expect(replaceState).toHaveBeenCalledWith(null, '', '/')
    stop()
  })
})

describe('startSessionDeepLink bridge', () => {
  it('answers false for a malformed id without side effects', async () => {
    const b = bench()
    for (const id of ['bad id', '', 'a'.repeat(129), '../escape']) {
      await expect(b.target.__DSH_BRIDGE__!.selectSession(id)).resolves.toBe(false)
    }
    expect(b.openSession).not.toHaveBeenCalled()
    expect(b.reportMissing).not.toHaveBeenCalled()
  })

  it('answers false before the Session list is ready, without side effects', async () => {
    const b = bench()
    await expect(b.target.__DSH_BRIDGE__!.selectSession('alpha')).resolves.toBe(false)
    expect(b.openSession).not.toHaveBeenCalled()
    expect(b.reportMissing).not.toHaveBeenCalled()
  })

  it('selects a catalogued id once the list is ready', async () => {
    const b = bench({ sessions: sessionState(['alpha']) })
    await expect(b.target.__DSH_BRIDGE__!.selectSession('alpha')).resolves.toBe(true)
    expect(b.openSession).toHaveBeenCalledExactlyOnceWith(sid('alpha'))
  })

  it('refuses an uncatalogued id through the notice path', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const b = bench({ sessions: sessionState(['alpha']) })
    await expect(b.target.__DSH_BRIDGE__!.selectSession('ghost')).resolves.toBe(false)
    expect(b.openSession).not.toHaveBeenCalled()
    expect(b.reportMissing).toHaveBeenCalledExactlyOnceWith(sid('ghost'))
    expect(warn).toHaveBeenCalledWith('session deep link: the Session list has no session ghost')
  })

  it('exposes only selectSession on the bridge global', () => {
    const b = bench()
    expect(Object.keys(b.target.__DSH_BRIDGE__!)).toEqual(['selectSession'])
  })
})
