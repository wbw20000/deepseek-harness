/**
 * The real wire path: a real WebServer, the real Connection service, the real
 * Typert Gateway, and the facade, exercised over HTTP with a loopback Host
 * header (the stable host) and a non-loopback Host header (`phone.example`, a
 * forwarded phone caller). The Gateway forwards only `RemoteError`s and folds
 * everything else into `gateway/internal`, so the assertions pin the machine
 * readable refusal codes surviving the whole transport.
 * @module gateway-wire.spec
 */

import { request as httpRequest } from 'node:http'
import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply as applyConnection, inject as connectionInject, type HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import { SelfDevelopmentTasks } from '@deepseek-ai/dsh-workflow-self-development'
import SelfDevelopmentRemote from '../src/index.ts'
import { provideBrowserCredentials } from '../../../api/gateway/tests/browser-credentials.ts'
import { makeEnvironment } from './helpers.ts'

const TASK_ID = 'task-remote-gateway'
const PHONE_HOST = 'phone.example:8787'

const SPEC = {
  taskId: TASK_ID,
  version: 1,
  requirement: '让标记文件读作 DONE',
  allowedModificationScope: ['marker.txt'],
  stableBaselineDigest: 'a'.repeat(64),
  createdBy: 'tester',
}

interface WireFailure {
  readonly code: string
  readonly message: string
  readonly details: Record<string, unknown>
}

interface WireResult {
  readonly ok: boolean
  readonly value?: unknown
  readonly error?: WireFailure
}

let root: string | undefined
let context: Context | undefined

/** One session cookie per Host authority; the cookie binds the exchanging authority. */
const cookies = new Map<string, string>()

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  cookies.clear()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Boot the full host stack over one environment: WebServer, Connection, Typert
 * Registry and Gateway, the task-control service, and the facade. The phone
 * authority is a trusted host so its requests pass the /api trust fence and
 * reach the facade as a non-loopback caller.
 * @returns the WebServer port as a string.
 */
async function makeStack(): Promise<string> {
  const env = await makeEnvironment()
  root = env.base
  context = new Context()
  await context.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  provideBrowserCredentials(context)
  await context.plugin(TypertRegistry)
  await context.plugin(TypertGatewayService)
  await context.plugin({ inject: [...connectionInject], apply: applyConnection }, {
    trustedHosts: [PHONE_HOST],
  })
  new SelfDevelopmentTasks(context, {
    controlDirectory: env.controlDirectory,
    maxRecordsPerSegment: 100,
    checkpointInterval: 10,
  })
  new SelfDevelopmentRemote(context, {
    enabled: true,
    allowedActors: [],
    controlDirectory: env.controlDirectory,
  })
  const port = String(context.webServer.port)
  for (const host of [`127.0.0.1:${port}`, PHONE_HOST]) exchangeCookie(host)
  return port
}

/** Exchange one browser process token for the session cookie one Host authority presents. */
function exchangeCookie(host: string): void {
  const connection = context!.get('connection') as HostConnectionHandle
  const target = new URL(connection.authenticatedUrl(`http://${host}`))
  let setCookie: string | undefined
  connection.authorizeIndex({
    method: 'GET',
    url: `${target.pathname}${target.search}`,
    headers: { host },
    remoteAddress: '127.0.0.1',
  }, {
    writeHead(_status: number, headers?: Record<string, unknown>) {
      setCookie = headers?.['set-cookie'] as string | undefined
    },
    end() {},
  })
  if (setCookie === undefined) throw new Error(`gateway-wire fixture did not receive a cookie for ${host}`)
  cookies.set(host, setCookie.split(';', 1)[0]!)
}

/**
 * POST one Remote invocation to the real /api channel with an explicit Host
 * header, the fact the facade's caller check reads.
 * @param port - the WebServer port.
 * @param host - the Host header value.
 * @param method - the facade's Remote method name.
 * @param args - the wire arguments, keyed by the facade's parameter names.
 * @returns the parsed wire result.
 */
async function postRemote(port: string, host: string, method: string, args: object): Promise<WireResult> {
  const body = JSON.stringify({
    type: 'client-request',
    rpcId: 'rpc-gateway-wire',
    method: `selfDevelopmentRemote/${method}`,
    payload: { args },
  })
  return await new Promise<WireResult>((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port: Number(port),
      path: `/api/selfDevelopmentRemote/${method}`,
      method: 'POST',
      headers: {
        host,
        cookie: cookies.get(host),
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, (response) => {
      response.setEncoding('utf8')
      let raw = ''
      response.on('data', (chunk: string) => { raw += chunk })
      response.on('end', () => {
        try {
          const parsed = JSON.parse(raw) as { result: WireResult }
          resolve(parsed.result)
        } catch (error) {
          reject(new Error(`gateway-wire fixture received a non-JSON response: ${raw}`, { cause: error }))
        }
      })
    })
    request.on('error', reject)
    request.end(body)
  })
}

describe('facade refusals over the real gateway', () => {
  it('keeps the host-only refusal code across the wire for a phone Host header', { timeout: 30_000 }, async () => {
    const port = await makeStack()
    const result = await postRemote(port, PHONE_HOST, 'createTask', { spec: SPEC, expectedRevision: 0 })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('self-development/host-only-field')
    expect(result.error?.message).toContain('isolation settings')
    expect(result.error?.details).toEqual({})
  })

  it('does not refuse createTask for the loopback Host header', { timeout: 30_000 }, async () => {
    const port = await makeStack()
    const result = await postRemote(port, `127.0.0.1:${port}`, 'createTask', { spec: SPEC, expectedRevision: 0 })
    expect(result.error?.code).not.toBe('self-development/host-only-field')
    expect(result.ok).toBe(true)
    expect(result.value).toMatchObject({ taskId: TASK_ID, revision: 1 })
  })
})
