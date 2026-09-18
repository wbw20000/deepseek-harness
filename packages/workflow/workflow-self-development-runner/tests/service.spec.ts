/**
 * Service boundary behavior: boot-time config validation for the supervised
 * runner's absolute-path, evidence-placement, and kill-grace rules, plus the
 * Loader composition smoke for the opt-in service lifecycle.
 * @module service.spec
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SelfDevelopmentRunner from '../src/index.ts'
import type { RunnerConfig } from '../src/types.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Build a valid runner config rooted at a fresh temporary directory pair. */
async function makeConfig(overrides: Partial<RunnerConfig> = {}): Promise<RunnerConfig> {
  const base = await mkdtemp(join(tmpdir(), 'self-dev-runner-'))
  root = base
  return {
    nodeBinary: join(base, 'node'),
    dshBin: join(base, 'apps', 'cli', 'lib', 'bin.js'),
    dshHome: join(base, 'home'),
    experimentsRoot: join(base, 'experiments'),
    evidenceRoot: join(base, 'evidence'),
    killGraceMs: 1000,
    ...overrides,
  }
}

describe('boot-time config validation', () => {
  it.each([
    ['nodeBinary'],
    ['dshBin'],
    ['dshHome'],
    ['experimentsRoot'],
    ['evidenceRoot'],
  ] as const)('refuses a relative %s at construction', async (field) => {
    const config = await makeConfig({ [field]: 'relative/path' })
    const rejected = () => new SelfDevelopmentRunner(new Context(), config)
    expect(rejected).toThrow(expect.objectContaining({ code: 'SELF_DEV_RUNNER_CONFIG_INVALID' }))
  })

  it.each([
    ['nodeBinary'],
    ['dshBin'],
    ['dshHome'],
    ['experimentsRoot'],
    ['evidenceRoot'],
  ] as const)('refuses an empty %s at construction', async (field) => {
    const config = await makeConfig({ [field]: '' })
    const rejected = () => new SelfDevelopmentRunner(new Context(), config)
    expect(rejected).toThrow(/must be an absolute path/)
    expect(rejected).toThrow(expect.objectContaining({ code: 'SELF_DEV_RUNNER_CONFIG_INVALID' }))
  })

  it.each([
    ['nodeBinary'],
    ['dshBin'],
    ['dshHome'],
    ['experimentsRoot'],
    ['evidenceRoot'],
    ['killGraceMs'],
  ] as const)('refuses a missing %s at construction', async (field) => {
    // Bypass the Config schema the way a hand-built config object would.
    const full = await makeConfig()
    const partial = Object.fromEntries(Object.entries(full).filter(([key]) => key !== field))
    const config = partial as unknown as RunnerConfig
    const rejected = () => new SelfDevelopmentRunner(new Context(), config)
    expect(rejected).toThrow(expect.objectContaining({ code: 'SELF_DEV_RUNNER_CONFIG_INVALID' }))
  })

  it('refuses an evidenceRoot equal to experimentsRoot', async () => {
    const config = await makeConfig()
    const rejected = () => new SelfDevelopmentRunner(new Context(), { ...config, evidenceRoot: config.experimentsRoot })
    expect(rejected).toThrow(/evidenceRoot/)
    expect(rejected).toThrow(expect.objectContaining({ code: 'SELF_DEV_RUNNER_CONFIG_INVALID' }))
  })

  it('refuses an evidenceRoot inside experimentsRoot', async () => {
    const config = await makeConfig()
    const rejected = () => new SelfDevelopmentRunner(new Context(), { ...config, evidenceRoot: join(config.experimentsRoot, 'evidence') })
    expect(rejected).toThrow(/evidenceRoot/)
    expect(rejected).toThrow(expect.objectContaining({ code: 'SELF_DEV_RUNNER_CONFIG_INVALID' }))
  })

  it('refuses an evidence directory inside a two-dot-prefixed child name', async () => {
    const config = await makeConfig()
    const rejected = () => new SelfDevelopmentRunner(new Context(), { ...config, evidenceRoot: join(config.experimentsRoot, '..records') })
    expect(rejected).toThrow(expect.objectContaining({ code: 'SELF_DEV_RUNNER_CONFIG_INVALID' }))
  })

  it.each([
    ['zero grace', 0],
    ['negative grace', -1],
    ['fractional grace', 2.5],
    ['infinite grace', Number.POSITIVE_INFINITY],
    ['NaN grace', Number.NaN],
  ])('refuses %s', async (_name, killGraceMs) => {
    const config = await makeConfig({ killGraceMs })
    const rejected = () => new SelfDevelopmentRunner(new Context(), config)
    expect(rejected).toThrow(expect.objectContaining({ code: 'SELF_DEV_RUNNER_CONFIG_INVALID' }))
  })
})

describe('service lifecycle', () => {
  it('mounts with a valid config and registers ctx.selfDevelopmentRunner', async () => {
    const config = await makeConfig()
    context = new Context()
    const service = new SelfDevelopmentRunner(context, config)
    expect(context.selfDevelopmentRunner).toBeInstanceOf(SelfDevelopmentRunner)
    expect(service.name).toBe('selfDevelopmentRunner')
  })
})

describe('Loader composition smoke', () => {
  it('boots the opt-in service from cordis.yml', async () => {
    const config = await makeConfig()
    const configPath = join(config.experimentsRoot, '..', 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-workflow-self-development-runner'",
      '  config:',
      `    nodeBinary: '${config.nodeBinary}'`,
      `    dshBin: '${config.dshBin}'`,
      `    dshHome: '${config.dshHome}'`,
      `    experimentsRoot: '${config.experimentsRoot}'`,
      `    evidenceRoot: '${config.evidenceRoot}'`,
      '    killGraceMs: 1000',
      '',
    ].join('\n'))
    context = new Context()
    context.baseUrl = `${pathToFileURL(config.experimentsRoot).href}/`
    // The runner declares `inject: ['selfDevelopmentTasks']`; the smoke test
    // stubs that dependency because the task-control package is not mounted.
    context.provide('selfDevelopmentTasks', {} as never)
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (specifier !== '@deepseek-ai/dsh-workflow-self-development-runner') {
          throw new Error(`unexpected Loader import: ${specifier}`)
        }
        return import('../src/index.ts')
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await context.loader.await()
    expect(context.selfDevelopmentRunner).toBeInstanceOf(SelfDevelopmentRunner)
    await context.fiber.dispose()
    context = undefined
  })
})
