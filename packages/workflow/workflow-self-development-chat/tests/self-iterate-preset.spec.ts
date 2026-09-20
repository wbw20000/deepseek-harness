/**
 * The opt-in `self-iterate` agent preset shipped under this package's own
 * `presets/` directory (not inside `@deepseek-ai/dsh-agent-presets`'s
 * bundled set, so a deployment must add it as a root explicitly — see
 * `packages/bundle/web-app/overlays/self-development.overlay.yml`). Loaded
 * through `@deepseek-ai/dsh-agent-presets`'s own roster, the same way its
 * `shipped-root.spec.ts` loads the bundled presets, so discovery health is
 * exercised for real rather than re-implemented here.
 * @module self-iterate-preset.spec
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include, { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as yaml from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'

/** This package's own preset root — one level above `tests/`. */
const PRESETS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'presets')

/** Repository root, five levels above `tests/` (package dir, group, `packages/`, repo). */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

/** Tool and shell packages that would let the preset change the workspace itself. */
const CHANGE_CAPABLE_PACKAGES = [
  '@deepseek-ai/dsh-tool-fs',
  '@deepseek-ai/dsh-tool-str-replace-editor',
  '@deepseek-ai/dsh-tool-bash',
  '@deepseek-ai/dsh-tool-bash-persistent',
  '@deepseek-ai/dsh-tool-pwsh',
  '@deepseek-ai/dsh-tool-pwsh-persistent',
  '@deepseek-ai/dsh-terminal',
  '@deepseek-ai/dsh-terminal-bash',
]

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

/** Boot a roster scoped to only this package's own preset root. */
async function roster(): Promise<Context> {
  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(REPO_ROOT).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentPresets, {
    default: 'self-iterate',
    roots: [{ path: PRESETS_ROOT, trust: 'system' }],
    includeShippedRoot: false,
    includeUserRoot: false,
  })
  return ctx
}

/** One row of `presets/self-iterate/agent.cordis.yml`, as the loader's own dialect parses it. */
interface PresetRow {
  readonly id?: unknown
  readonly name: string
  readonly config?: Record<string, unknown>
}

/** Read and validate the preset's Cordis entry list, mirroring `shipped-root.spec.ts`'s `shippedEntries`. */
async function selfIterateEntries(): Promise<PresetRow[]> {
  const source = await readFile(join(PRESETS_ROOT, 'self-iterate', 'agent.cordis.yml'), 'utf8')
  const entries: unknown = yaml.load(source, { schema: entryListSchema })
  if (!Array.isArray(entries)) throw new TypeError('self-iterate preset must contain a Cordis entry list')
  return entries as PresetRow[]
}

describe('the self-iterate preset', () => {
  it('is discovered from this package\'s own preset root, with its preset.yml metadata', async () => {
    const ctx = await roster()
    const listed = await ctx.agentPresets.list()
    const preset = listed.find(entry => entry.id === 'self-iterate')
    expect(preset).toBeDefined()
    expect(preset?.trust).toBe('system')
    expect(preset?.name).toBe('自迭代模式')
    expect(preset?.description).toContain('自开发')
    expect(preset?.order).toBe(5)
    // Health may report the shipped rows unresolved from this fixture-style
    // base without failing the test — see shipped-root.spec.ts's own note —
    // but a malformed composition is a different, real failure.
    expect(preset?.broken === undefined || preset?.broken.includes('cannot be resolved')).toBe(true)
  })

  it('declares exactly the persona, agent-instructions, and read-only search rows', async () => {
    const entries = await selfIterateEntries()
    expect(entries.map(entry => entry.id)).toEqual(['persona', 'agent-instructions', 'tool-fs-search'])
    expect(entries.map(entry => entry.name)).toEqual([
      '@deepseek-ai/dsh-persona',
      '@deepseek-ai/dsh-agent-instructions',
      '@deepseek-ai/dsh-tool-fs-search',
    ])
  })

  it('mounts no file-editing or shell tool', async () => {
    const entries = await selfIterateEntries()
    const names = entries.map(entry => entry.name)
    for (const forbidden of CHANGE_CAPABLE_PACKAGES) expect(names).not.toContain(forbidden)
  })

  it('frames the mode without replacing the rest of the assembled prompt, and keeps runtime context', async () => {
    const entries = await selfIterateEntries()
    const persona = entries.find(entry => entry.id === 'persona')
    expect(persona?.config?.complete).toBe(false)
    expect(persona?.config?.includeRuntimeContext).toBe(true)
    const prefix = persona?.config?.prefix
    expect(typeof prefix).toBe('string')
    expect(prefix as string).toContain('self_development_propose')
    expect(prefix as string).toContain('no file-editing or shell tool')
  })
})
