/**
 * The browser plugin's registrations and their removal: the tab type, the two
 * seats, the dictionaries, and the optional availability fibers. The registry
 * is real; the slot, locale, and remote faces are recorders, mirroring what
 * the apply body hands them.
 */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SidebarRightTabRegistry } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-registry.ts'
import { apply, inject } from '../src/client/index.ts'
import { apply as hostApply } from '../src/index.ts'
import { NS, SELF_DEVELOPMENT_ID, SELF_DEVELOPMENT_KIND, selfDevelopmentDefinition } from '../src/client/definition.ts'
import { SelfDevelopmentPanel } from '../src/client/SelfDevelopmentPanel.tsx'
import { en, zh } from '../src/client/locales.ts'

interface Recorded {
  name: string
  key?: string
  id?: string
  locale?: string
  inject?: unknown
  label?: unknown
  component: unknown
}

interface Boot {
  readonly ctx: Context
  readonly registered: Recorded[]
  readonly dictionaries: Map<string, unknown>
  readonly tabs: SidebarRightTabRegistry
  readonly injected: () => Record<string, unknown>
}

async function boot(loopback = true): Promise<Boot> {
  const ctx = new Context()
  const tabs = new SidebarRightTabRegistry(ctx)
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
  ctx.provide('sidebarRightTabs', tabs as never)
  ctx.provide('slots', slots as never)
  ctx.provide('locale', locale as never)
  ctx.provide('remote', { $host: { home: undefined, isLoopback: loopback } } as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  onTestFinished(async () => { await fiber.dispose() })
  await fiber.await()
  const injected = (): Record<string, unknown> => {
    const pane = registered.find(entry => entry.name === 'sidebar.right.pane.tab')
    return (pane?.inject as () => Record<string, unknown>)()
  }
  return { ctx, registered, dictionaries, tabs, injected }
}

/** The availability snapshot the pane's inject face reports. */
function availabilitySnapshot(face: Record<string, unknown>): unknown {
  return (face.hooks as { availability: { getSnapshot(): object } }).availability.getSnapshot()
}

describe('ui-self-development apply', () => {
  it('keeps the host loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('declares the services the two seats read, without the opt-in host faces', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'sidebarRightTabs'])
  })

  it('defines one page-type tab with a guide entry and no address patterns', () => {
    const definition = selfDevelopmentDefinition(key => en[key])
    expect(definition).toMatchObject({ id: SELF_DEVELOPMENT_ID, kind: SELF_DEVELOPMENT_KIND, priority: 'builtin' })
    expect(definition.patterns).toBeUndefined()
    expect(definition.title('sidebar://guide')).toBe('Self-development tasks')
    expect(definition.guide?.[0]?.title?.()).toBe('Self-development tasks')
    expect(definition.guide?.[0]?.description?.()).toBe('Confirmation card, per-round evidence, and the authorization actions')
  })

  it('registers the dictionaries, the tab type, and both seats under the type id', async () => {
    const { registered, dictionaries, tabs } = await boot()
    expect(dictionaries.get(NS)).toEqual({ zh, en })
    expect(tabs.get(SELF_DEVELOPMENT_KIND)?.id).toBe(SELF_DEVELOPMENT_ID)
    expect(registered.map(entry => [entry.name, entry.key ?? entry.id, entry.locale, entry.component])).toEqual([
      ['sidebar.right.pane.tab', SELF_DEVELOPMENT_ID, NS, SelfDevelopmentPanel],
      ['settings.section', 'self-development', NS, SelfDevelopmentPanel],
    ])
    const section = registered.find(entry => entry.name === 'settings.section')
    expect((section?.label as () => string)()).toBe('nav')
  })

  it('keeps the mounted namespace undefined until a composition provides it, then flips availability', async () => {
    const { ctx, injected } = await boot()
    expect(injected().remote).toBeUndefined()
    expect(availabilitySnapshot(injected())).toEqual({ remote: false })

    const api = { listTasks: vi.fn() }
    ctx.provide('remote.selfDevelopmentRemote', api as never)
    await vi.waitFor(() => {
      expect(availabilitySnapshot(injected())).toEqual({ remote: true })
    })
    expect(injected().remote).toBe(api)
  })

  it('reports a phone client from non-loopback host facts', async () => {
    const { injected } = await boot(false)
    expect(injected().phone).toBe(true)
  })

  it('takes every registration back when the plugin is disposed', async () => {
    const ctx = new Context()
    const tabs = new SidebarRightTabRegistry(ctx)
    const registered: Recorded[] = []
    const slots = {
      inject: vi.fn((_name: string, register: () => () => void) => register()),
      register: vi.fn((options: Omit<Recorded, 'component'>, component: unknown) => {
        const entry: Recorded = { ...options, component }
        registered.push(entry)
        return () => { registered.splice(registered.indexOf(entry), 1) }
      }),
    }
    const locale = { bind: () => () => 'x', register: vi.fn(() => () => {}) }
    ctx.provide('sidebarRightTabs', tabs as never)
    ctx.provide('slots', slots as never)
    ctx.provide('locale', locale as never)
    ctx.provide('remote', { $host: { home: undefined, isLoopback: false } } as never)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await fiber.dispose()
    expect(registered).toEqual([])
    expect(tabs.get(SELF_DEVELOPMENT_KIND)).toBeUndefined()
  })
})
