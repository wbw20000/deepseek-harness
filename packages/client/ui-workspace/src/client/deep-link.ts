/**
 * Session deep links: the `/session/<id>` startup route and the native-shell
 * `window.__DSH_BRIDGE__` capability. Both accept the same Session-id form and
 * resolve it against the ready Session Controller list; an unresolvable id
 * selects nothing and is reported through the host's non-blocking notice. The
 * startup route consumes the id once and rewrites the address back to `/`, so
 * the id never stays in the URL bar.
 * @module
 */
import type { ISessions, SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'

/** Accepted Session-id form inside a deep link: 1–128 id characters. */
const SESSION_ID_FRAGMENT = '[A-Za-z0-9._-]{1,128}'
const SESSION_ID_PATTERN = new RegExp(`^${SESSION_ID_FRAGMENT}$`)

/** Path form of a session deep link; capture 1 is the Session id. */
export const SESSION_DEEP_LINK_PATTERN = new RegExp(`^/session/(${SESSION_ID_FRAGMENT})$`)

/**
 * Test one id against the deep-link id form.
 * @param id - candidate Session id.
 * @returns whether `id` uses only deep-link id characters within the length bound.
 */
export function isSessionDeepLinkId(id: string): boolean {
  return SESSION_ID_PATTERN.test(id)
}

/**
 * Extract the Session id from a deep-link path.
 * @param pathname - document path to inspect.
 * @returns the encoded Session id, or undefined for every other path.
 */
export function parseSessionDeepLink(pathname: string): SessionId | undefined {
  const match = SESSION_DEEP_LINK_PATTERN.exec(pathname)
  const id = match?.[1]
  return id === undefined ? undefined : SessionId(id)
}

/** The one capability the native shell may call; the bridge object exposes nothing else. */
export interface SessionBridge {
  /**
   * Select one Session by id as the main view.
   * @param id - Session id to select.
   * @returns whether the Session was selected. `false` before the Session list
   * is ready, for an id outside the accepted form, and for an id the ready
   * list does not catalogue; `true` only after the selection succeeded.
   */
  selectSession(id: string): Promise<boolean>
}

/** A window carrying the optional native-shell bridge global. */
export interface BridgeWindow {
  __DSH_BRIDGE__?: SessionBridge
}

/** Collaboration face the deep-link watcher needs; the plugin apply supplies it. */
export interface DeepLinkHost {
  /** Session Controller list snapshot source; read-only use. */
  readonly sessions: Pick<ISessions, 'list'>
  /** Selects one catalogued Session as the main view. */
  readonly openSession: (sessionId: SessionId) => void
  /** Shows the existing non-blocking notice for an unresolvable deep link. */
  readonly reportMissing: (sessionId: SessionId) => void
}

/** Document and history facts the watcher touches; tests substitute fakes. */
export interface DeepLinkEnvironment {
  /** Startup document path, or undefined outside a browser document. */
  readonly pathname: string | undefined
  /** Rewrites the current history entry without navigation. */
  readonly replacePath: (path: string) => void
}

/** Published deep-link notice: the id the page could not open. */
export interface DeepLinkNotice {
  readonly sessionId?: SessionId
}

/** Reads the real browser document path and history; tolerant of non-browser hosts. */
function browserEnvironment(): DeepLinkEnvironment {
  const scope = globalThis as {
    location?: { pathname?: string }
    history?: { replaceState(...args: unknown[]): void }
  }
  return {
    pathname: scope.location?.pathname,
    replacePath: (path) => { scope.history?.replaceState(null, '', path) },
  }
}

class DeepLinkController {
  private pending: SessionId | undefined

  constructor(
    private readonly host: DeepLinkHost,
    private readonly environment: DeepLinkEnvironment,
  ) {
    this.pending = parseSessionDeepLink(environment.pathname ?? '')
  }

  /**
   * Consume the startup deep link once the Session list is ready.
   * @returns disposer releasing the list subscription.
   */
  start(): () => void {
    if (this.pending === undefined) return () => {}
    const dispose = this.host.sessions.list.subscribe(() => { this.consumeStartup() })
    this.consumeStartup()
    return dispose
  }

  /** Bridge selection; every refusal answers `false` without side effects. */
  select(id: string): Promise<boolean> {
    if (!isSessionDeepLinkId(id)) return Promise.resolve(false)
    const sessions = this.host.sessions.list.getSnapshot()
    if (sessions.phase !== 'ready') return Promise.resolve(false)
    return Promise.resolve(this.accept(id as SessionId, sessions))
  }

  /** One-time startup consumption; the address is cleaned whichever way it resolves. */
  private consumeStartup(): void {
    const id = this.pending
    if (id === undefined) return
    const sessions = this.host.sessions.list.getSnapshot()
    if (sessions.phase !== 'ready') return
    this.pending = undefined
    this.environment.replacePath('/')
    this.accept(id, sessions)
  }

  /** Accept or refuse one id against a ready list; failures never escape as exceptions. */
  private accept(id: SessionId, sessions: SessionListState): boolean {
    if (sessions.byId[id] === undefined) {
      console.warn(`session deep link: the Session list has no session ${id}`)
      this.host.reportMissing(id)
      return false
    }
    try {
      this.host.openSession(id)
    } catch (reason) {
      // The selection host owns its failure presentation; this path stays non-throwing.
      console.warn(`session deep link: selecting session ${id} failed:`, reason)
      this.host.reportMissing(id)
      return false
    }
    return true
  }
}

/**
 * Start the session deep-link surface: consume the startup `/session/<id>`
 * route and install `window.__DSH_BRIDGE__.selectSession(id)`.
 * @param host - selection and notice collaboration face.
 * @param environment - browser facts; defaults to the real document and history.
 * @param target - object receiving the bridge global; defaults to `globalThis`.
 * @returns disposer that removes the bridge global and stops the startup watcher.
 */
export function startSessionDeepLink(
  host: DeepLinkHost,
  environment: DeepLinkEnvironment = browserEnvironment(),
  target: BridgeWindow = globalThis as BridgeWindow,
): () => void {
  const controller = new DeepLinkController(host, environment)
  const stopStartup = controller.start()
  const bridge: SessionBridge = { selectSession: id => controller.select(id) }
  target.__DSH_BRIDGE__ = bridge
  return () => {
    stopStartup()
    if (target.__DSH_BRIDGE__ === bridge) delete target.__DSH_BRIDGE__
  }
}
