// Example APNs outbound command for @deepseek-ai/dsh-push-registry.
//
// NOT VERIFIED END-TO-END AGAINST THE REAL APNS SERVICE. Before any production
// use, exercise this script against the sandbox host `api.sandbox.push.apple.com`
// (`APNS_ENV=sandbox`) with a real device token, .p8 key, and bundle id.
//
// The APNs provider API accepts HTTP/2 only, and Node's global `fetch` speaks
// HTTP/1.1, so this template opens one `node:http2` client session per
// delivery.
//
// The push-registry service spawns this script once per device and event and
// hands the delivery payload on stdin:
//
//   { "event": { "kind", "sessionId", "title", "occurredAt" },
//     "device": { "deviceId", "platform", "token" } }
//
// Configuration comes from the environment:
//
//   APNS_KEY_PATH    path to the .p8 signing key (keep it outside the repo)
//   APNS_KEY_ID      10-character key id from the Apple developer portal
//   APNS_TEAM_ID     10-character team id
//   APNS_BUNDLE_ID   app bundle id the token is registered for
//   APNS_ENV         "production" (default) or "sandbox"
//
// Exit 0 tells the registry the delivery succeeded; any other exit is retried
// per the service's maxRetries and then recorded as failed. This file is a
// template: review it, provision real secrets, and point the service's
// `outboundCommand` at your copy.

import { createSign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { connect } from 'node:http2'
import { derSignatureToRaw } from './der-to-raw.mjs'

for (const name of ['APNS_KEY_PATH', 'APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_BUNDLE_ID']) {
  if (!process.env[name]) {
    console.error(`apns-send: missing environment variable ${name}`)
    process.exit(2)
  }
}

const payload = JSON.parse(readFileSync(0, 'utf8'))

const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: process.env.APNS_KEY_ID })).toString('base64url')
const claims = Buffer.from(JSON.stringify({
  iss: process.env.APNS_TEAM_ID,
  iat: Math.floor(Date.now() / 1000),
})).toString('base64url')
const signingInput = `${header}.${claims}`
// JWT ES256: the DER ECDSA signature converted to the 64-byte raw r||s form.
const signature = derSignatureToRaw(
  createSign('sha256').update(signingInput).sign(readFileSync(process.env.APNS_KEY_PATH, 'utf8')),
)

const host = process.env.APNS_ENV === 'sandbox' ? 'api.sandbox.push.apple.com' : 'api.push.apple.com'
const body = JSON.stringify({ aps: { alert: { title: payload.event.title } } })

const session = connect(`https://${host}`)
const request = session.request({
  ':method': 'POST',
  ':path': `/3/device/${encodeURIComponent(payload.device.token)}`,
  authorization: `bearer ${signingInput}.${signature.toString('base64url')}`,
  'apns-topic': process.env.APNS_BUNDLE_ID,
  'apns-push-type': 'alert',
  'content-type': 'application/json',
  'content-length': Buffer.byteLength(body),
})

let status
let response = ''
request.setEncoding('utf8')
request.on('response', headers => { status = headers[':status'] })
request.end(body)
for await (const chunk of request) response += chunk
session.close()

if (status === undefined || status < 200 || status >= 300) {
  console.error(`apns-send: HTTP ${status ?? 'no response'}: ${response}`)
  process.exit(1)
}
