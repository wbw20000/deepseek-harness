/** Host WebSocket owner for multiplexed Typert Remote streams. */

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import WebSocket, { WebSocketServer, type RawData } from 'ws'
import type { ConnectionCaller } from '@deepseek-ai/dsh-client-connection'
import {
  parseRemoteStreamClientMessage,
  type RemoteStreamFailure,
  type RemoteStreamServerMessage,
} from './stream-protocol.ts'

/** Open one validated Remote stream for a decoded wire request. */
export type RemoteStreamOpener = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
) => Promise<AsyncIterable<unknown>>

/** Convert an invocation or carrier failure to a stable wire value. */
export type RemoteStreamFailureMapper = (error: unknown) => RemoteStreamFailure

/**
 * Caller identity applied to every Remote invocation on one mux connection.
 * The Gateway derives it once per connection from the upgrade request and
 * runs each logical stream's opener inside it. When the composition provides
 * no Connection service, the mux has no caller scope and keeps the previous
 * behavior.
 */
export interface RemoteStreamMuxCallerScope {
  /**
   * Derive one connection's caller identity from its upgrade request.
   * @param request - authenticated HTTP upgrade request.
   * @returns the caller identity of this connection.
   */
  callerOf(request: IncomingMessage): ConnectionCaller

  /**
   * Run one invocation inside the caller's identity context.
   * @param caller - identity of the connection serving this invocation.
   * @param invoke - opener call to execute.
   * @returns whatever `invoke` returns.
   */
  run<T>(caller: ConnectionCaller, invoke: () => T): T
}

const MAX_MISSED_HEARTBEATS = 2

/** Termination status and reason applied to mux connections of a revoked session. */
const SESSION_REVOKED_CLOSE = { code: 4401, reason: 'session revoked' } as const

/** One accepted mux connection and the session identity it was accepted for. */
interface MuxConnectionEntry {
  readonly done: Promise<void>
  readonly sessionId: string | undefined
}

/** Own the no-server WebSocket acceptor and every active logical stream. */
export class RemoteStreamMuxServer {
  private readonly server = new WebSocketServer({ noServer: true })
  private readonly connections = new Map<RemoteStreamMuxConnection, MuxConnectionEntry>()
  private readonly missedHeartbeats = new WeakMap<WebSocket, number>()
  private heartbeatTimer: NodeJS.Timeout | undefined

  /**
   * @param open - Gateway stream dispatcher.
   * @param failure - Gateway error-to-wire mapper.
   * @param heartbeatIntervalMs - interval between WebSocket Ping control frames.
   * @param caller - Connection caller scope applied to every invocation, or undefined when no Connection service is mounted.
   */
  constructor(
    private readonly open: RemoteStreamOpener,
    private readonly failure: RemoteStreamFailureMapper,
    private readonly heartbeatIntervalMs: number,
    private readonly caller?: RemoteStreamMuxCallerScope,
  ) {}

  /**
   * Upgrade one trusted request and begin serving its logical streams.
   * @param req - authenticated HTTP upgrade request.
   * @param socket - carrier socket transferred to the WebSocket server.
   * @param head - bytes already read after the HTTP upgrade headers.
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.server.handleUpgrade(req, socket, head, (websocket) => {
      this.missedHeartbeats.set(websocket, 0)
      websocket.on('pong', () => { this.missedHeartbeats.set(websocket, 0) })
      this.startHeartbeat()
      const caller = this.caller?.callerOf(req)
      const connection = new RemoteStreamMuxConnection(websocket, this.caller, caller, this.open, this.failure)
      const done = connection.run()
      this.connections.set(connection, { done, sessionId: caller?.sessionId })
      void done.then(() => { this.connections.delete(connection) })
    })
  }

  /**
   * Close every connection whose session appears in `revoked` with the
   * `session revoked` status; each connection aborts and settles its logical
   * streams before its socket closes.
   * @param revoked - session ids one revocation removed.
   */
  closeSessions(revoked: readonly string[]): void {
    const revokedSessionIds = new Set(revoked)
    for (const [connection, entry] of this.connections) {
      if (entry.sessionId === undefined || !revokedSessionIds.has(entry.sessionId)) continue
      connection.close(SESSION_REVOKED_CLOSE.code, SESSION_REVOKED_CLOSE.reason)
    }
  }

  /** Terminate all sockets and wait until every iterator has returned. */
  async close(): Promise<void> {
    clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
    for (const socket of this.server.clients) socket.terminate()
    const closed = Promise.withResolvers<void>()
    this.server.close((error) => {
      if (error === undefined) closed.resolve()
      else closed.reject(error)
    })
    await closed.promise
    await Promise.all([...this.connections.values()].map(entry => entry.done))
  }

  /** Start one `unref()` timer after the first upgrade; it spans empty-client periods until close(). */
  private startHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) return
    this.heartbeatTimer = setInterval(() => {
      for (const socket of this.server.clients) {
        if (socket.readyState !== WebSocket.OPEN) continue
        const missed = this.missedHeartbeats.get(socket) as number
        if (missed >= MAX_MISSED_HEARTBEATS) {
          setImmediate(() => {
            if ((this.missedHeartbeats.get(socket) as number) >= MAX_MISSED_HEARTBEATS) {
              socket.terminate()
            }
          })
          continue
        }
        this.missedHeartbeats.set(socket, missed + 1)
        socket.ping()
      }
    }, this.heartbeatIntervalMs)
    this.heartbeatTimer.unref()
  }
}

interface ActiveStream {
  readonly abort: AbortController
  done: Promise<void>
}

class RemoteStreamMuxConnection {
  private readonly streams = new Map<string, ActiveStream>()
  private writes = Promise.resolve()

  constructor(
    private readonly socket: WebSocket,
    private readonly scope: RemoteStreamMuxCallerScope | undefined,
    private readonly caller: ConnectionCaller | undefined,
    private readonly open: RemoteStreamOpener,
    private readonly failure: RemoteStreamFailureMapper,
  ) {}

  /** Request the closing handshake; logical streams settle when the socket closes. */
  close(code: number, reason: string): void {
    this.socket.close(code, reason)
  }

  async run(): Promise<void> {
    const closed = new Promise<void>((resolve) => {
      this.socket.once('close', resolve)
      this.socket.once('error', () => { this.socket.terminate() })
      this.socket.on('message', (data, isBinary) => {
        if (isBinary) {
          this.socket.close(1003, 'text messages required')
          return
        }
        try {
          this.receive(rawText(data))
        } catch {
          this.socket.close(1008, 'invalid Remote stream request')
        }
      })
    })
    await closed
    const active = [...this.streams.values()]
    for (const stream of active) stream.abort.abort(new Error('Remote stream socket closed'))
    await Promise.all(active.map(stream => stream.done))
  }

  private receive(text: string): void {
    const message = parseRemoteStreamClientMessage(text)
    if (message.type === 'cancel') {
      this.streams.get(message.streamId)?.abort.abort(new Error('Remote stream cancelled'))
      return
    }
    if (this.streams.has(message.streamId)) {
      throw new Error(`api gateway: duplicate Remote stream id ${JSON.stringify(message.streamId)}`)
    }
    const abort = new AbortController()
    const active: ActiveStream = {
      abort,
      done: Promise.resolve(),
    }
    this.streams.set(message.streamId, active)
    const done = this.pump(message.streamId, message.endpoint, message.payload, active)
    active.done = done
    const remove = (): void => { this.streams.delete(message.streamId) }
    void done.then(remove, remove)
  }

  private pump(
    streamId: string,
    endpoint: string,
    payload: unknown,
    active: ActiveStream,
  ): Promise<void> {
    // Every @Remote invocation on this connection — opening and consuming —
    // runs inside the identity derived from its upgrade request, so business
    // code reads the caller with `ctx.connection.caller.current()`. The whole
    // consumption stays inside the scope because an async generator reads the
    // ambient identity at each resumption, not only at creation.
    return this.runCaller(() => this.consume(streamId, endpoint, payload, active))
  }

  private async consume(
    streamId: string,
    endpoint: string,
    payload: unknown,
    active: ActiveStream,
  ): Promise<void> {
    try {
      const source = await this.open(endpoint, payload, active.abort.signal)
      for await (const value of source) {
        await this.send({ type: 'item', streamId, value })
      }
      if (!active.abort.signal.aborted) await this.send({ type: 'end', streamId })
    } catch (error) {
      if (!active.abort.signal.aborted && this.socket.readyState === WebSocket.OPEN) {
        try {
          await this.send({ type: 'error', streamId, error: this.failure(error) })
        } catch {
          // A terminal frame that cannot be encoded or written leaves the
          // logical stream ambiguous, so fail the physical generation.
          this.socket.close(1011, 'Remote stream failure could not be delivered')
        }
      }
    }
  }

  /** Run one opener inside the connection's caller identity, or bare without a Connection scope. */
  private runCaller<T>(invoke: () => T): T {
    if (this.scope === undefined || this.caller === undefined) return invoke()
    return this.scope.run(this.caller, invoke)
  }

  private send(message: RemoteStreamServerMessage): Promise<void> {
    let text: string
    try {
      text = JSON.stringify(message)
    } catch (cause) {
      return Promise.reject(new Error('api gateway: Remote stream item is not JSON serializable', { cause }))
    }
    const delivery = this.writes.then(() => new Promise<void>((resolve, reject) => {
      if (this.socket.readyState !== WebSocket.OPEN) {
        reject(new Error('api gateway: Remote stream socket is closed'))
        return
      }
      this.socket.send(text, (error) => {
        if (error) reject(error)
        else resolve()
      })
    }))
    this.writes = delivery.catch(() => undefined)
    return delivery
  }
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}

/**
 * Reject an upgrade without transferring socket ownership to ws.
 * @param socket - carrier socket that receives the HTTP rejection.
 * @param status - authentication or browser-trust rejection status.
 */
export function rejectRemoteStreamUpgrade(socket: Duplex, status: 401 | 403): void {
  const reason = status === 401 ? 'Unauthorized' : 'Forbidden'
  const body = reason.toLowerCase()
  socket.end([
    `HTTP/1.1 ${String(status)} ${reason}`,
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${String(Buffer.byteLength(body))}`,
    '',
    body,
  ].join('\r\n'))
}
