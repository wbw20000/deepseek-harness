/**
 * Data-home template copy behavior: regular content travels, sessions and
 * attachments subtrees and lock files are pruned during the walk, and a
 * missing template is reported before any copy starts.
 * @module template.spec
 */

import { existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { copyDataHomeTemplate, templateExists } from '../src/template.ts'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Build a template directory with kept and excluded content. */
async function makeTemplate(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'self-dev-template-'))
  const template = join(root, 'template')
  await mkdir(join(template, 'config'), { recursive: true })
  await mkdir(join(template, 'deep', 'nested'), { recursive: true })
  await mkdir(join(template, 'sessions', 'inside'), { recursive: true })
  await mkdir(join(template, 'deep', 'attachments'), { recursive: true })
  await writeFile(join(template, 'settings.json'), '{}\n')
  await writeFile(join(template, 'config', 'providers.json'), '[]\n')
  await writeFile(join(template, 'deep', 'nested', 'model.txt'), 'm\n')
  await writeFile(join(template, 'sessions', 'inside', 'log.json'), 'log\n')
  await writeFile(join(template, 'deep', 'attachments', 'a.bin'), 'a\n')
  await writeFile(join(template, 'singleton.lock'), 'lock\n')
  await writeFile(join(template, 'deep', 'nested', 'op.lock'), 'lock\n')
  return template
}

describe('data-home template copy', () => {
  it('copies kept content and prunes sessions, attachments, and lock files', async () => {
    const template = await makeTemplate()
    const dataHome = join(root!, 'task', 'dsh-home')
    await copyDataHomeTemplate(template, dataHome)
    expect(await readFile(join(dataHome, 'settings.json'), 'utf8')).toBe('{}\n')
    expect(await readFile(join(dataHome, 'config', 'providers.json'), 'utf8')).toBe('[]\n')
    expect(await readFile(join(dataHome, 'deep', 'nested', 'model.txt'), 'utf8')).toBe('m\n')
    expect(existsSync(join(dataHome, 'sessions'))).toBe(false)
    expect(existsSync(join(dataHome, 'deep', 'attachments'))).toBe(false)
    expect(existsSync(join(dataHome, 'singleton.lock'))).toBe(false)
    expect(existsSync(join(dataHome, 'deep', 'nested', 'op.lock'))).toBe(false)
  })

  it('reports a copy failure as an allocation failure with the cause kept', async () => {
    const template = await makeTemplate()
    const dataHome = join(root!, 'task', 'dsh-home')
    // A file where a template subdirectory must be created blocks the copy.
    await mkdir(join(root!, 'task'), { recursive: true })
    await writeFile(dataHome, 'not a directory\n')
    await expect(copyDataHomeTemplate(template, dataHome))
      .rejects.toMatchObject({ code: 'SELF_DEV_WORKSPACE_ALLOC_FAILED' })
  })

  it('reports a missing template directory', async () => {
    root = await mkdtemp(join(tmpdir(), 'self-dev-template-'))
    expect(await templateExists(join(root, 'missing'))).toBe(false)
    expect(await templateExists(root)).toBe(true)
  })

  it('rethrows unexpected stat failures from the template check', async () => {
    root = await mkdtemp(join(tmpdir(), 'self-dev-template-'))
    const template = join(root, 'template')
    await mkdir(template, { recursive: true })
    await chmod(root, 0o000)
    try {
      await expect(templateExists(template)).rejects.toMatchObject({ code: 'EACCES' })
    } finally {
      await chmod(root, 0o755)
    }
  })

  it('keeps file modes on copied entries', async () => {
    const template = await makeTemplate()
    await chmod(join(template, 'settings.json'), 0o600)
    const dataHome = join(root!, 'task', 'dsh-home')
    await copyDataHomeTemplate(template, dataHome)
    const copied = await readFile(join(dataHome, 'settings.json'), 'utf8')
    expect(copied).toBe('{}\n')
  })

  it('copies are independent of later template edits', async () => {
    const template = await makeTemplate()
    const dataHome = join(root!, 'task', 'dsh-home')
    await copyDataHomeTemplate(template, dataHome)
    await copyFile(join(template, 'settings.json'), join(template, 'later.txt'))
    expect(existsSync(join(dataHome, 'later.txt'))).toBe(false)
  })
})
