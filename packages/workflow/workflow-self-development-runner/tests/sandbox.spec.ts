/**
 * macOS file-level sandbox (Tier 1) primitives: Seatbelt profile text
 * (escaping, deny-after-allow ordering, multiple/duplicate roots), path
 * resolution through the filesystem (existing paths, not-yet-existing paths,
 * symlinked ancestors, a non-directory component), relative-path rejection,
 * `wrapCommand`'s argv shape, the darwin-only probe and availability gate,
 * and the profile digest recorded on evidence.
 *
 * The portable tests below drive every branch through the exported
 * `platform` override parameters, so they run and mean something on any
 * host. Only the "real sandbox-exec enforcement" block spawns the actual
 * `/usr/bin/sandbox-exec` binary and depends on genuine kernel enforcement;
 * that block is darwin-only and each of its cases skips with a printed
 * reason elsewhere.
 * @module sandbox.spec
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_SANDBOX_CONFIG,
  assertSandboxAvailable,
  assertSandboxRootsAbsolute,
  buildSeatbeltProfile,
  prepareSandboxProfile,
  probeSandbox,
  resolveSandboxRoot,
  sandboxEffectivelyEnabled,
  sandboxLaunchFailed,
  spawnConfined,
  wrapCommand,
} from '../src/sandbox.ts'
import type { SandboxConfig } from '../src/types.ts'

// Wrapped (not replaced) so every other test still hits the real filesystem;
// only the error-handling tests below override one call with `mockImplementationOnce`.
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, realpath: vi.fn(actual.realpath) }
})

const fakeCase = fileURLToPath(new URL('./fixtures/fake-case.mjs', import.meta.url))

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.mocked(realpath).mockClear()
})

/** Fresh temporary directory for one test, removed in `afterEach`. */
async function tempRoot(prefix = 'sandbox-spec-'): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), prefix))
  root = base
  return base
}

/** Write an executable POSIX shell script at `path`. */
async function writeScript(path: string, body: string): Promise<void> {
  await writeFile(path, body)
  await chmod(path, 0o755)
}

describe('buildSeatbeltProfile', () => {
  it('emits only the fixed default-allow, global-write-deny, and /dev/null re-allow forms with no roots', () => {
    const profile = buildSeatbeltProfile({ writableRoots: [], denyReadRoots: [] })
    expect(profile).toBe('(version 1) (allow default) (deny file-write*) (allow file-write* (literal "/dev/null"))')
  })

  it('escapes backslashes before quotes in a root literal', () => {
    const tricky = String.raw`/tmp/weird "quoted" \ path`
    const profile = buildSeatbeltProfile({ writableRoots: [tricky], denyReadRoots: [] })
    // Hand-computed: one backslash doubles, both double quotes gain a backslash.
    expect(profile).toContain('(allow file-write* (subpath "/tmp/weird \\"quoted\\" \\\\ path"))')
  })

  it('grants every writable root in one allow form and dedupes exact-string duplicates', () => {
    const profile = buildSeatbeltProfile({ writableRoots: ['/a', '/b', '/a'], denyReadRoots: [] })
    expect(profile).toContain('(allow file-write* (subpath "/a") (subpath "/b"))')
    expect(profile.match(/subpath "\/a"/g)).toHaveLength(1)
  })

  it('places every deny-read form after the write-allow forms, in input order, deduped', () => {
    const profile = buildSeatbeltProfile({ writableRoots: ['/w'], denyReadRoots: ['/deny-a', '/deny-b', '/deny-a'] })
    const defaultAllowIdx = profile.indexOf('(allow default)')
    const writeAllowIdx = profile.indexOf('(allow file-write* (subpath "/w"))')
    const denyAIdx = profile.indexOf('(deny file-read* (subpath "/deny-a"))')
    const denyBIdx = profile.indexOf('(deny file-read* (subpath "/deny-b"))')
    expect([defaultAllowIdx, writeAllowIdx, denyAIdx, denyBIdx].every(index => index >= 0)).toBe(true)
    expect(defaultAllowIdx).toBeLessThan(writeAllowIdx)
    expect(writeAllowIdx).toBeLessThan(denyAIdx)
    expect(denyAIdx).toBeLessThan(denyBIdx)
    expect(profile.match(/deny file-read\* \(subpath "\/deny-a"\)/g)).toHaveLength(1)
  })

  it('carries no write-allow form when no writable root is granted, but still denies every deny-read root', () => {
    const profile = buildSeatbeltProfile({ writableRoots: [], denyReadRoots: ['/deny-only'] })
    expect(profile).not.toContain('allow file-write* (subpath')
    expect(profile).toContain('(deny file-read* (subpath "/deny-only"))')
  })

  it.each([
    ['writableRoots', { writableRoots: ['relative/root'], denyReadRoots: [] }],
    ['denyReadRoots', { writableRoots: [], denyReadRoots: ['relative/root'] }],
  ] as const)('rejects a relative %s entry before building any text', (_field, input) => {
    expect(() => buildSeatbeltProfile(input)).toThrow(expect.objectContaining({ code: 'SELF_DEV_RUNNER_CONFIG_INVALID' }))
  })
})

describe('wrapCommand', () => {
  it('prefixes the argv with the sandbox executable, -p, and the profile, in fixed positions', () => {
    const wrapped = wrapCommand('/usr/bin/sandbox-exec', 'PROFILE-TEXT', ['/bin/echo', 'hi', 'there'])
    expect(wrapped).toEqual(['/usr/bin/sandbox-exec', '-p', 'PROFILE-TEXT', '/bin/echo', 'hi', 'there'])
    expect(wrapped[0]).toBe('/usr/bin/sandbox-exec')
    expect(wrapped[1]).toBe('-p')
    expect(wrapped[2]).toBe('PROFILE-TEXT')
  })

  it('carries an empty argv through unchanged past the fixed prefix', () => {
    expect(wrapCommand('/x/sandbox-exec', 'P', [])).toEqual(['/x/sandbox-exec', '-p', 'P'])
  })
})

describe('resolveSandboxRoot', () => {
  it('resolves an existing path to its realpath', async () => {
    const base = await tempRoot()
    await expect(resolveSandboxRoot(base)).resolves.toBe(await realpath(base))
  })

  it('resolves a symlinked ancestor and reports the target spelling', async () => {
    const base = await tempRoot()
    const realDir = join(base, 'real-dir')
    await mkdir(realDir)
    const linkDir = join(base, 'link-dir')
    await symlink(realDir, linkDir)
    await expect(resolveSandboxRoot(linkDir)).resolves.toBe(await realpath(realDir))
  })

  it('resolves the deepest existing ancestor and appends a not-yet-existing tail literally', async () => {
    const base = await tempRoot()
    const target = join(base, 'not-yet', 'nested', 'file.txt')
    await expect(resolveSandboxRoot(target)).resolves.toBe(join(await realpath(base), 'not-yet', 'nested', 'file.txt'))
  })

  it('resolves a symlinked ancestor even when the tail past it does not exist yet', async () => {
    const base = await tempRoot()
    const realDir = join(base, 'real-dir')
    await mkdir(realDir)
    const linkDir = join(base, 'link-dir')
    await symlink(realDir, linkDir)
    const target = join(linkDir, 'not-yet', 'x')
    await expect(resolveSandboxRoot(target)).resolves.toBe(join(await realpath(realDir), 'not-yet', 'x'))
  })

  it('walks past a path component that exists but is not a directory (ENOTDIR)', async () => {
    const base = await tempRoot()
    const notADir = join(base, 'plain-file')
    await writeFile(notADir, 'content')
    const target = join(notADir, 'child')
    await expect(resolveSandboxRoot(target)).resolves.toBe(join(await realpath(notADir), 'child'))
  })

  it('rethrows a realpath failure that is a real errno error but not a missing-path code', async () => {
    // EACCES is a proper errno-shaped rejection, just not ENOENT/ENOTDIR: the
    // walk must not treat a permission failure as "not created yet".
    vi.mocked(realpath).mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }))
    await expect(resolveSandboxRoot('/wherever')).rejects.toMatchObject({ code: 'EACCES' })
  })

  it('rethrows a realpath rejection that carries no errno code at all', async () => {
    // Defensive-only path: the real fs.realpath never rejects with a
    // non-errno value, but the walk must still fail closed if it ever did.
    vi.mocked(realpath).mockRejectedValueOnce('not even an Error object')
    await expect(resolveSandboxRoot('/wherever')).rejects.toBe('not even an Error object')
  })
})

describe('assertSandboxRootsAbsolute', () => {
  it('accepts the default sandbox configuration', () => {
    expect(() => { assertSandboxRootsAbsolute(DEFAULT_SANDBOX_CONFIG) }).not.toThrow()
  })

  it('rejects an empty sandboxExec', () => {
    const sandbox: SandboxConfig = { ...DEFAULT_SANDBOX_CONFIG, sandboxExec: '' }
    const rejected = (): void => { assertSandboxRootsAbsolute(sandbox) }
    expect(rejected).toThrow(/sandbox\.sandboxExec/)
    expect(rejected).toThrow(expect.objectContaining({ code: 'SELF_DEV_RUNNER_CONFIG_INVALID' }))
  })

  it('rejects a relative sandboxExec', () => {
    const sandbox: SandboxConfig = { ...DEFAULT_SANDBOX_CONFIG, sandboxExec: 'relative/sandbox-exec' }
    const rejected = (): void => { assertSandboxRootsAbsolute(sandbox) }
    expect(rejected).toThrow(/sandbox\.sandboxExec/)
    expect(rejected).toThrow(expect.objectContaining({ code: 'SELF_DEV_RUNNER_CONFIG_INVALID' }))
  })

  it('rejects a relative denyReadRoots entry', () => {
    const sandbox: SandboxConfig = { ...DEFAULT_SANDBOX_CONFIG, denyReadRoots: ['/ok', 'relative'] }
    const rejected = (): void => { assertSandboxRootsAbsolute(sandbox) }
    expect(rejected).toThrow(/sandbox\.denyReadRoots/)
    expect(rejected).toThrow(expect.objectContaining({ code: 'SELF_DEV_RUNNER_CONFIG_INVALID' }))
  })

  it('rejects a relative extraWritableRoots entry', () => {
    const sandbox: SandboxConfig = { ...DEFAULT_SANDBOX_CONFIG, extraWritableRoots: ['relative'] }
    const rejected = (): void => { assertSandboxRootsAbsolute(sandbox) }
    expect(rejected).toThrow(/sandbox\.extraWritableRoots/)
    expect(rejected).toThrow(expect.objectContaining({ code: 'SELF_DEV_RUNNER_CONFIG_INVALID' }))
  })
})

describe('probeSandbox', () => {
  it('reports unavailable on a non-darwin platform without spawning', async () => {
    // An unresolvable path would reject if this ever tried to spawn.
    await expect(probeSandbox('/no/such/sandbox-exec', 'linux')).resolves.toBe('unavailable')
  })

  it('reports unavailable when the executable does not exist, on darwin', async () => {
    const base = await tempRoot()
    await expect(probeSandbox(join(base, 'does-not-exist'), 'darwin')).resolves.toBe('unavailable')
  })

  it('reports unavailable when the probe process exits non-zero, on darwin', async () => {
    const base = await tempRoot()
    const failing = join(base, 'fake-sandbox-exec-fail.sh')
    await writeScript(failing, '#!/bin/sh\nexit 7\n')
    await expect(probeSandbox(failing, 'darwin')).resolves.toBe('unavailable')
  })

  it('reports available when the probe process exits zero, on darwin', async () => {
    const base = await tempRoot()
    const passthrough = join(base, 'fake-sandbox-exec-ok.sh')
    await writeScript(passthrough, '#!/bin/sh\nshift 2\nexec "$@"\n')
    await expect(probeSandbox(passthrough, 'darwin')).resolves.toBe('available')
  })
})

describe('assertSandboxAvailable', () => {
  const unresolvable: SandboxConfig = { ...DEFAULT_SANDBOX_CONFIG, sandboxExec: '/no/such/sandbox-exec' }

  it('never probes when the deployment disabled sandboxing', async () => {
    await expect(assertSandboxAvailable({ ...unresolvable, enabled: false }, 'darwin')).resolves.toBeUndefined()
  })

  it('never probes on a non-darwin platform, even when enabled', async () => {
    await expect(assertSandboxAvailable({ ...unresolvable, enabled: true }, 'linux')).resolves.toBeUndefined()
  })

  it('rejects with SELF_DEV_RUNNER_SANDBOX_UNAVAILABLE when enabled, darwin, and the probe fails', async () => {
    await expect(assertSandboxAvailable({ ...unresolvable, enabled: true }, 'darwin'))
      .rejects.toMatchObject({ code: 'SELF_DEV_RUNNER_SANDBOX_UNAVAILABLE' })
  })

  it('resolves when enabled, darwin, and the probe succeeds', async () => {
    const base = await tempRoot()
    const passthrough = join(base, 'fake-sandbox-exec-ok.sh')
    await writeScript(passthrough, '#!/bin/sh\nshift 2\nexec "$@"\n')
    await expect(assertSandboxAvailable({ ...DEFAULT_SANDBOX_CONFIG, sandboxExec: passthrough }, 'darwin')).resolves.toBeUndefined()
  })
})

describe('sandboxEffectivelyEnabled', () => {
  it('is true only when the deployment enabled sandboxing and the host is darwin', () => {
    expect(sandboxEffectivelyEnabled({ ...DEFAULT_SANDBOX_CONFIG, enabled: true }, 'darwin')).toBe(true)
    expect(sandboxEffectivelyEnabled({ ...DEFAULT_SANDBOX_CONFIG, enabled: true }, 'linux')).toBe(false)
    expect(sandboxEffectivelyEnabled({ ...DEFAULT_SANDBOX_CONFIG, enabled: false }, 'darwin')).toBe(false)
    expect(sandboxEffectivelyEnabled({ ...DEFAULT_SANDBOX_CONFIG, enabled: false }, 'win32')).toBe(false)
  })
})

describe('sandboxLaunchFailed', () => {
  it('recognizes sandbox-exec\'s own diagnostic prefix and nothing else', () => {
    expect(sandboxLaunchFailed('sandbox-exec: some-binary: Operation not permitted\n')).toBe(true)
    expect(sandboxLaunchFailed('')).toBe(false)
    expect(sandboxLaunchFailed('a normal stderr line that only mentions sandbox in passing')).toBe(false)
  })
})

describe('prepareSandboxProfile', () => {
  it('grants the worktree, the data home, the system temp roots, and every extra writable root', async () => {
    const base = await tempRoot()
    const worktree = join(base, 'worktree')
    const dshHome = join(base, 'dsh-home')
    await mkdir(worktree, { recursive: true })
    await mkdir(dshHome, { recursive: true })
    const extra = join(base, 'extra')
    await mkdir(extra, { recursive: true })
    const sandbox: SandboxConfig = { ...DEFAULT_SANDBOX_CONFIG, extraWritableRoots: [extra] }
    const prepared = await prepareSandboxProfile({ sandbox, worktreeReal: worktree, dshHomeReal: dshHome })
    expect(prepared.profile).toContain(await realpath(worktree))
    expect(prepared.profile).toContain(await realpath(dshHome))
    expect(prepared.profile).toContain(await realpath(extra))
    expect(prepared.profile).toContain('/private/tmp')
    const expectedDigest = createHash('sha256').update(prepared.profile, 'utf8').digest('hex')
    expect(prepared.profileDigest).toBe(expectedDigest)
    expect(prepared.profileDigest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('denies every configured deny-read root', async () => {
    const base = await tempRoot()
    const worktree = join(base, 'worktree')
    const denyRoot = join(base, 'deny-me')
    await mkdir(worktree, { recursive: true })
    await mkdir(denyRoot, { recursive: true })
    const sandbox: SandboxConfig = { ...DEFAULT_SANDBOX_CONFIG, denyReadRoots: [denyRoot] }
    const prepared = await prepareSandboxProfile({ sandbox, worktreeReal: worktree, dshHomeReal: worktree })
    expect(prepared.profile).toContain(`(deny file-read* (subpath ${JSON.stringify(await realpath(denyRoot))}))`)
  })

  it('grants the $TMPDIR spelling when the environment sets one', async () => {
    const base = await tempRoot()
    const worktree = join(base, 'worktree')
    await mkdir(worktree, { recursive: true })
    const customTmp = join(base, 'custom-tmp')
    await mkdir(customTmp, { recursive: true })
    const savedTmpdir = process.env.TMPDIR
    process.env.TMPDIR = customTmp
    try {
      const prepared = await prepareSandboxProfile({ sandbox: DEFAULT_SANDBOX_CONFIG, worktreeReal: worktree, dshHomeReal: worktree })
      expect(prepared.profile).toContain(await realpath(customTmp))
    } finally {
      if (savedTmpdir === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = savedTmpdir
    }
  })

  it('omits a fourth $TMPDIR spelling when the environment sets none', async () => {
    const base = await tempRoot()
    const worktree = join(base, 'worktree')
    await mkdir(worktree, { recursive: true })
    const savedTmpdir = process.env.TMPDIR
    delete process.env.TMPDIR
    try {
      const withoutTmpdir = await prepareSandboxProfile({ sandbox: DEFAULT_SANDBOX_CONFIG, worktreeReal: worktree, dshHomeReal: worktree })
      delete process.env.TMPDIR
      process.env.TMPDIR = join(base, 'a-distinct-custom-tmp')
      await mkdir(process.env.TMPDIR, { recursive: true })
      const withTmpdir = await prepareSandboxProfile({ sandbox: DEFAULT_SANDBOX_CONFIG, worktreeReal: worktree, dshHomeReal: worktree })
      // The only difference between the two profiles is the extra $TMPDIR form.
      expect(withTmpdir.profile).not.toBe(withoutTmpdir.profile)
      expect(withoutTmpdir.profile).not.toContain('a-distinct-custom-tmp')
    } finally {
      if (savedTmpdir === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = savedTmpdir
    }
  })
})

describe('spawnConfined', () => {
  it('wraps the program through the given sandboxExec and preserves the caller-visible pid through the exec', async () => {
    const base = await tempRoot()
    const passthrough = join(base, 'passthrough-sandbox-exec.sh')
    await writeScript(passthrough, '#!/bin/sh\nshift 2\nexec "$@"\n')
    const pidFile = join(base, 'pid.txt')
    const sandbox: SandboxConfig = { ...DEFAULT_SANDBOX_CONFIG, sandboxExec: passthrough }
    const child = await spawnConfined(
      sandbox,
      { worktreeReal: base, dshHomeReal: base },
      process.execPath,
      [fakeCase, 'pidfile', pidFile, '10'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    await new Promise<void>((resolve) => { child.on('exit', () => { resolve() } ) })
    const reportedPid = Number((await readFile(pidFile, 'utf8')).trim())
    expect(child.pid).toBeDefined()
    // sandbox-exec execve()s the target in place: Node's own spawn() pid is
    // the same pid the wrapped program ultimately runs (and reports) as.
    expect(reportedPid).toBe(child.pid)
  })

  it('passes the wrapped program its own argv, unaffected by the wrap', async () => {
    const base = await tempRoot()
    const passthrough = join(base, 'passthrough-sandbox-exec.sh')
    await writeScript(passthrough, '#!/bin/sh\nshift 2\nexec "$@"\n')
    const outFile = join(base, 'out.txt')
    const sandbox: SandboxConfig = { ...DEFAULT_SANDBOX_CONFIG, sandboxExec: passthrough }
    const child = await spawnConfined(
      sandbox,
      { worktreeReal: base, dshHomeReal: base },
      process.execPath,
      [fakeCase, 'write', outFile, 'via-spawnConfined'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    await new Promise<void>((resolve) => { child.on('exit', () => { resolve() } ) })
    await expect(readFile(outFile, 'utf8')).resolves.toBe('via-spawnConfined')
  })
})

describe('DEFAULT_SANDBOX_CONFIG', () => {
  it('is sandboxing on, no extra roots, and the system sandbox-exec', () => {
    expect(DEFAULT_SANDBOX_CONFIG).toEqual({
      enabled: true,
      denyReadRoots: [],
      extraWritableRoots: [],
      sandboxExec: '/usr/bin/sandbox-exec',
    })
  })
})

/** Run one already-wrapped argv to completion and collect its streams. */
function runWrapped(wrapped: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = wrapped
    if (cmd === undefined) throw new Error('empty wrapped command')
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', reject)
    child.on('close', (code) => { resolve({ code, stdout, stderr }) })
  })
}

const REAL_SANDBOX_SKIP_REASON = 'real sandbox-exec enforcement only runs on darwin (this host is not darwin)'

/** Run a real-`sandbox-exec`-enforcement case, or record it skipped with a printed reason elsewhere. */
function realSandboxIt(name: string, fn: () => Promise<void>): void {
  if (process.platform !== 'darwin') {
    it.skip(`${name} (skipped: ${REAL_SANDBOX_SKIP_REASON})`, fn)
    return
  }
  it(name, fn, 20_000)
}

describe('real sandbox-exec enforcement', () => {
  realSandboxIt('accepts the probe profile through the real sandbox-exec binary', async () => {
    await expect(probeSandbox('/usr/bin/sandbox-exec')).resolves.toBe('available')
  })

  realSandboxIt('permits a write under a granted writable root', async () => {
    const base = await tempRoot()
    const writable = join(base, 'writable')
    await mkdir(writable, { recursive: true })
    const target = join(writable, 'ok.txt')
    const profile = buildSeatbeltProfile({ writableRoots: [await realpath(writable)], denyReadRoots: [] })
    const wrapped = wrapCommand('/usr/bin/sandbox-exec', profile, [process.execPath, fakeCase, 'write', target, 'hello'])
    const { code } = await runWrapped(wrapped)
    expect(code).toBe(0)
    await expect(readFile(target, 'utf8')).resolves.toBe('hello')
  })

  realSandboxIt('refuses a write outside every granted writable root', async () => {
    const base = await tempRoot()
    const writable = join(base, 'writable')
    await mkdir(writable, { recursive: true })
    // `outside` is deliberately never created here: the sandboxed child must
    // fail to create it, under a `base` that is not itself a writable root.
    const target = join(base, 'outside', 'blocked.txt')
    const profile = buildSeatbeltProfile({ writableRoots: [await realpath(writable)], denyReadRoots: [] })
    const wrapped = wrapCommand('/usr/bin/sandbox-exec', profile, [process.execPath, fakeCase, 'write', target, 'hello'])
    const { code } = await runWrapped(wrapped)
    expect(code).not.toBe(0)
    await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  realSandboxIt('refuses a read under a denied read root', async () => {
    const base = await tempRoot()
    const secretDir = join(base, 'secret')
    await mkdir(secretDir, { recursive: true })
    const secretFile = join(secretDir, 'secret.txt')
    await writeFile(secretFile, 'top-secret-content')
    const writable = join(base, 'writable')
    await mkdir(writable, { recursive: true })
    const profile = buildSeatbeltProfile({
      writableRoots: [await realpath(writable)],
      denyReadRoots: [await realpath(secretDir)],
    })
    const wrapped = wrapCommand('/usr/bin/sandbox-exec', profile, [process.execPath, fakeCase, 'read', secretFile])
    const { code, stdout } = await runWrapped(wrapped)
    expect(code).not.toBe(0)
    expect(stdout).not.toContain('top-secret-content')
  })

  realSandboxIt('still permits a read outside any denied read root (this is a write fence, not full isolation)', async () => {
    const base = await tempRoot()
    const readableDir = join(base, 'readable')
    await mkdir(readableDir, { recursive: true })
    const readableFile = join(readableDir, 'note.txt')
    await writeFile(readableFile, 'not-secret')
    const writable = join(base, 'writable')
    await mkdir(writable, { recursive: true })
    const profile = buildSeatbeltProfile({ writableRoots: [await realpath(writable)], denyReadRoots: [] })
    const wrapped = wrapCommand('/usr/bin/sandbox-exec', profile, [process.execPath, fakeCase, 'read', readableFile])
    const { code, stdout } = await runWrapped(wrapped)
    expect(code).toBe(0)
    expect(stdout).toBe('not-secret')
  })
})
