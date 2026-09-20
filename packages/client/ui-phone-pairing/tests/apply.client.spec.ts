/**
 * The browser plugin's registrations and their removal: the dictionaries and
 * the one settings section, with the injected face's phone fact and the
 * fetch port wired to the window fetch through the test hook.
 */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply, inject, internals, NS, PHONE_PAIRING_SECTION_ID } from '../src/client/index.ts'
import { apply as hostApply } from '../src/index.ts'
import { PhonePairingPanel } from '../src/client/PhonePairingPanel.tsx'
import type { PhonePairingInjected } from '../src/client/PhonePairingPanel.tsx'
import { en, zh } from '../src/client/locales.ts'

interface Recorded {
  name: string
  id?: string
  locale?: string
  inject?: unknown
  label?: unknown
  component: unknown
}

/** The one registered seat; the registration test proves there is exactly one. */
function only(registered: Recorded[]): Recorded {
  const [first, ...rest] = registered
  if (first === undefined || rest.length > 0) throw new Error(`expected one registration, got ${String(registered.length)}`)
  return first
}

/** The path a fetch call names; the api only ever passes strings. */
function requestPath(input: string | URL | Request): string {
  return typeof input === 'string' ? input : 'non-string input'
}

interface Booted {
  registered: Recorded[]
  dictionaries: Map<string, unknown>
  dispose: () => Promise<void>
}

async function boot(loopback = true): Promise<Booted> {
  const ctx = new Context()
  const registered: Recorded[] = []
  const slots = {
    inject: vi.fn((_name: string, register: () => () => void) => register()),
    register: vi.fn((options: Omit<Recorded, 'component'>, component: unknown) => {
      const entry: Recorded = { ...options, component }
      registered.push(entry)
      return () => { registered.splice(registered.indexOf(entry), 1) }
    }),
  }
  const dictionaries = new Map<string, unknown>()
  const locale = {
    bind: () => (key: string) => key,
    register: vi.fn((ns: string, dicts: unknown) => {
      dictionaries.set(ns, dicts)
      return () => { dictionaries.delete(ns) }
    }),
  }
  ctx.provide('slots', slots as never)
  ctx.provide('locale', locale as never)
  ctx.provide('remote', { $host: { home: undefined, isLoopback: loopback } } as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  onTestFinished(async () => { await fiber.dispose() })
  await fiber.await()
  return { registered, dictionaries, dispose: () => fiber.dispose() }
}

describe('ui-phone-pairing apply', () => {
  it('keeps the host loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('declares the services the section reads', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote'])
  })

  it('registers the dictionaries and the settings section, and removes both on disposal', async () => {
    const { registered, dictionaries, dispose } = await boot()
    expect(dictionaries.get(NS)).toEqual({ zh, en })
    expect(registered.map(entry => [entry.name, entry.id, entry.locale, entry.component])).toEqual([
      ['settings.section', PHONE_PAIRING_SECTION_ID, NS, PhonePairingPanel],
    ])
    const section = only(registered)
    expect((section.label as () => string)()).toBe('nav')
    const face = (section.inject as () => PhonePairingInjected)()
    expect(face.phone).toBe(false)
    expect(typeof face.now()).toBe('number')
    await dispose()
    expect(registered).toEqual([])
    expect(dictionaries.size).toBe(0)
  })

  it('reports a phone client from non-loopback host facts and routes the api through the fetch hook', async () => {
    const { registered } = await boot(false)
    const face = (only(registered).inject as () => PhonePairingInjected)()
    expect(face.phone).toBe(true)
    const original = internals.fetch
    const seen: string[] = []
    internals.fetch = async (input) => {
      seen.push(requestPath(input))
      return Response.json({ sessions: [] })
    }
    try {
      await expect(face.api.sessions()).resolves.toEqual([])
      expect(seen).toEqual(['/api/connection.sessions'])
    } finally {
      internals.fetch = original
    }
  })

  it('defaults the fetch hook to the global fetch', async () => {
    const original = globalThis.fetch
    const seen: string[] = []
    globalThis.fetch = async (input) => {
      seen.push(requestPath(input))
      return Response.json({ sessions: [] })
    }
    try {
      await internals.fetch('/api/connection.sessions')
      expect(seen).toEqual(['/api/connection.sessions'])
    } finally {
      globalThis.fetch = original
    }
  })
})
