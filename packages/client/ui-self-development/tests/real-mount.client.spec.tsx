// @vitest-environment jsdom
/**
 * The real composition wiring: the api-remotes Client assembly mounts the
 * generated `selfDevelopmentRemote` contribution, the plugin's readiness fiber
 * flips availability, and the panel's buttons reach the mounted namespace's
 * methods over the typed Remote call path.
 */
import { cleanup, fireEvent, render } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply as applyGateway } from '@deepseek-ai/dsh-api-gateway/client'
import { apply as applyRemotes } from '@deepseek-ai/dsh-api-remotes/client'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { SidebarRightTabRegistry } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-registry.ts'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject } from '../src/client/index.ts'
import { SelfDevelopmentPanel } from '../src/client/SelfDevelopmentPanel.tsx'
import type { SelfDevelopmentAvailability, SelfDevelopmentInjected } from '../src/client/face.ts'
import { detail, summary } from './fixtures.client.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

/**
 * Boot the real Client Remote service over a scripted connection handle, run
 * the api-remotes mount assembly and the plugin, and return the panel's
 * injected face plus the recorded wire calls.
 */
async function boot(): Promise<{
  readonly injected: SelfDevelopmentInjected
  readonly calls: { method: string; args: unknown }[]
}> {
  const ctx = new Context()
  const calls: { method: string; args: unknown }[] = []
  const call = vi.fn<ConnectionHandle['rpc']['call']>(async (_endpoint, method, args) => {
    calls.push({ method, args })
    const value = method === 'selfDevelopmentRemote/listTasks'
      ? [summary()]
      : method === 'selfDevelopmentRemote/getTask' ? detail() : []
    return { ok: true as const, value }
  })
  await ctx.plugin(TypertRegistry)
  ctx.provide('connection', {
    rpc: { call },
    registerGenerationSource: () => () => {},
    start: () => ({ stop: () => {} }),
    generation: { getSnapshot: () => undefined },
    isLoopback: true,
  } as unknown as ConnectionHandle)
  await ctx.plugin({ inject: ['typert', 'connection'], apply: applyGateway })
  await ctx.plugin({ inject: ['remote'], apply: applyRemotes })

  const registered: { name: string; inject?: () => SelfDevelopmentInjected }[] = []
  ctx.provide('sidebarRightTabs', new SidebarRightTabRegistry(ctx) as never)
  ctx.provide('slots', {
    inject: (_name: string, register: () => () => void) => register(),
    register: (options: { name: string; inject?: () => SelfDevelopmentInjected }) => {
      registered.push(options)
      return () => {}
    },
  } as never)
  ctx.provide('locale', { bind: () => (key: string) => en[key as keyof typeof en], register: () => () => {} } as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber

  const pane = registered.find(entry => entry.name === 'sidebar.right.pane.tab')
  if (pane?.inject === undefined) throw new Error('the pane body was not registered')
  return { injected: pane.inject(), calls }
}

describe('real Client Remote mount', () => {
  it('mounts the generated selfDevelopmentRemote contribution and reports availability true', async () => {
    const { injected } = await boot()
    expect(injected.remote).toBeDefined()
    const availability: SelfDevelopmentAvailability = injected.hooks.availability.getSnapshot()
    expect(availability).toEqual({ remote: true })
  })

  it('drives the mounted namespace from the panel: the reload button reaches the wire', async () => {
    const { injected, calls } = await boot()
    const t = makeTranslate(en)
    const view = render(<SelfDevelopmentPanel
      t={t}
      {...injected}
      useAvailability={select => select(injected.hooks.availability.getSnapshot())}
    />)
    await vi.waitFor(() => { expect(view.getByText('修复导出按钮')).toBeDefined() })
    expect(calls.map(entry => entry.method)).toContain('selfDevelopmentRemote/listTasks')

    fireEvent.click(view.getByRole('button', { name: 'Reload' }))
    await vi.waitFor(() => {
      expect(calls.filter(entry => entry.method === 'selfDevelopmentRemote/listTasks')).toHaveLength(2)
    })
  })
})
