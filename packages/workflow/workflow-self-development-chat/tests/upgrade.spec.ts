/**
 * The post-integration upgrade: `none` runs nothing, `launcher` spawns the
 * packaged binary detached, and `source` fast-forwards, installs only when
 * `pnpm-lock.yaml` changed, builds, and restarts — exercised against real
 * temporary `git`/`pnpm` scripts on `PATH` (not injected fakes) for the
 * default command runner, and against injected fakes for the two side
 * effects no test should actually perform: the detached restart and this
 * process's own exit.
 * @module upgrade.spec
 */

import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RESTART_ESTIMATE_SECONDS,
  defaultRunCommand,
  defaultScheduleExit,
  defaultSpawnDetached,
  runUpgrade,
  upgradeViolation,
} from '../src/upgrade.ts'
import type { UpgradeConfig } from '../src/config.ts'

let root: string | undefined
let previousPath: string | undefined

afterEach(async () => {
  if (previousPath !== undefined) process.env.PATH = previousPath
  previousPath = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Install fake `git` and `pnpm` executables ahead of the real ones on
 * `PATH`, each appending its invocation (`git <args...>` / `pnpm <args...>`)
 * as one line to `logPath`. The fake `git` also writes `touchToken` into
 * `pnpm-lock.yaml` inside its `cwd` when `GIT_TOUCH_LOCKFILE=1` is set in
 * the environment, so a test can control whether a merge "changed" the
 * lockfile without a real merge.
 */
async function installFakeToolchain(binDir: string, logPath: string): Promise<void> {
  const gitScript = `#!/bin/sh
echo "git $*" >> "${logPath}"
if [ "$GIT_TOUCH_LOCKFILE" = "1" ]; then
  echo "changed-by-fake-git" >> pnpm-lock.yaml
fi
echo "Already up to date."
exit 0
`
  const pnpmScript = `#!/bin/sh
echo "pnpm $*" >> "${logPath}"
exit 0
`
  await writeFile(join(binDir, 'git'), gitScript, 'utf8')
  await writeFile(join(binDir, 'pnpm'), pnpmScript, 'utf8')
  await chmod(join(binDir, 'git'), 0o700)
  await chmod(join(binDir, 'pnpm'), 0o700)
  previousPath = process.env.PATH
  process.env.PATH = `${binDir}:${previousPath ?? ''}`
}

describe('runUpgrade', () => {
  it('runs nothing for upgrade.kind "none"', async () => {
    let spawned = false
    const outcome = await runUpgrade({ kind: 'none' }, 'stable', 'task-1', { spawnDetached: () => { spawned = true } })
    expect(outcome.ok).toBe(true)
    expect(spawned).toBe(false)
  })

  it('spawns the launcher detached with the task id for upgrade.kind "launcher"', async () => {
    const spawnedCommands: string[][] = []
    const outcome = await runUpgrade(
      { kind: 'launcher', dshUpgradeBin: 'dsh-upgrade' },
      'stable',
      'task-1',
      { spawnDetached: (command) => { spawnedCommands.push([...command]) } },
    )
    expect(outcome.ok).toBe(true)
    expect(outcome.detail).toContain('untested this wave')
    expect(spawnedCommands).toEqual([['dsh-upgrade', 'upgrade', '--task', 'task-1']])
  })

  it('merges, skips install, builds, and restarts detached when the lockfile is unchanged (real git/pnpm scripts on PATH)', async () => {
    root = await mkdtemp(join(tmpdir(), 'self-dev-chat-upgrade-'))
    const logPath = join(root, 'invocations.log')
    await installFakeToolchain(root, logPath)
    await writeFile(join(root, 'pnpm-lock.yaml'), 'unchanged\n', 'utf8')
    delete process.env.GIT_TOUCH_LOCKFILE

    let spawnedCommand: readonly string[] | undefined
    let spawnedCwd: string | undefined
    let exitCode: number | undefined
    let scheduledDelayMs: number | undefined
    const config: UpgradeConfig = { kind: 'source', projectRoot: root, restartCommand: ['d3/restart-d3.sh', '--quiet'] }
    const outcome = await runUpgrade(config, 'stable', 'task-1', {
      spawnDetached: (command, cwd) => { spawnedCommand = command; spawnedCwd = cwd },
      exit: (code) => { exitCode = code },
      scheduleExit: (run, delayMs) => { scheduledDelayMs = delayMs; run() },
    })

    expect(outcome.ok).toBe(true)
    expect(outcome.detail).toContain('stable')
    expect(outcome.detail).toContain(`${RESTART_ESTIMATE_SECONDS}s`)
    const log = await readFile(logPath, 'utf8')
    expect(log.split('\n').filter(line => line.length > 0)).toEqual([
      'git merge --ff-only stable',
      'pnpm run --silent build',
    ])
    expect(spawnedCommand).toEqual(['d3/restart-d3.sh', '--quiet'])
    expect(spawnedCwd).toBe(root)
    expect(scheduledDelayMs).toBe(2000)
    expect(exitCode).toBe(0)
  })

  it('installs (offline, frozen lockfile) only when merging changed pnpm-lock.yaml', async () => {
    root = await mkdtemp(join(tmpdir(), 'self-dev-chat-upgrade-'))
    const logPath = join(root, 'invocations.log')
    await installFakeToolchain(root, logPath)
    await writeFile(join(root, 'pnpm-lock.yaml'), 'before\n', 'utf8')
    process.env.GIT_TOUCH_LOCKFILE = '1'

    const config: UpgradeConfig = { kind: 'source', projectRoot: root, restartCommand: ['restart'] }
    const outcome = await runUpgrade(config, 'stable', 'task-1', {
      spawnDetached: () => {},
      exit: () => {},
      scheduleExit: (run) => { run() },
    })

    expect(outcome.ok).toBe(true)
    const log = await readFile(logPath, 'utf8')
    expect(log.split('\n').filter(line => line.length > 0)).toEqual([
      'git merge --ff-only stable',
      'pnpm install --offline --frozen-lockfile',
      'pnpm run --silent build',
    ])
  })

  it('never installs when installIfLockfileChanged is false, even though the lockfile changed', async () => {
    root = await mkdtemp(join(tmpdir(), 'self-dev-chat-upgrade-'))
    const logPath = join(root, 'invocations.log')
    await installFakeToolchain(root, logPath)
    await writeFile(join(root, 'pnpm-lock.yaml'), 'before\n', 'utf8')
    process.env.GIT_TOUCH_LOCKFILE = '1'

    const config: UpgradeConfig = { kind: 'source', projectRoot: root, restartCommand: ['restart'], installIfLockfileChanged: false }
    const outcome = await runUpgrade(config, 'stable', 'task-1', { spawnDetached: () => {}, exit: () => {}, scheduleExit: (run) => { run() } })

    expect(outcome.ok).toBe(true)
    const log = await readFile(logPath, 'utf8')
    expect(log.split('\n').filter(line => line.length > 0)).toEqual([
      'git merge --ff-only stable',
      'pnpm run --silent build',
    ])
  })

  it('reports a failed git merge without building or restarting', async () => {
    const outcome = await runUpgrade(
      { kind: 'source', projectRoot: '/does/not/exist', restartCommand: ['restart'] },
      'stable',
      'task-1',
      {
        git: async () => { throw Object.assign(new Error('fatal: not a git repository'), { stderr: 'fatal: not a git repository' }) },
        runCommand: async () => { throw new Error('runCommand must not be called after a failed merge') },
        spawnDetached: () => { throw new Error('spawnDetached must not be called after a failed merge') },
      },
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.detail).toContain('git merge --ff-only stable failed')
    expect(outcome.detail).toContain('not a git repository')
  })

  it('reports a failed build without restarting, after a successful install-free merge', async () => {
    let restarted = false
    const outcome = await runUpgrade(
      { kind: 'source', projectRoot: '/deploy', restartCommand: ['restart'] },
      'stable',
      'task-1',
      {
        git: async () => 'Already up to date.',
        readTextFile: async () => undefined,
        runCommand: async (argv) => {
          if (argv[1] === 'run') throw Object.assign(new Error('build failed'), { stderr: 'Error: build failed' })
        },
        spawnDetached: () => { restarted = true },
      },
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.detail).toContain('pnpm run --silent build failed')
    expect(outcome.detail).toContain('build failed')
    expect(restarted).toBe(false)
  })

  it('reports a failed install without building or restarting', async () => {
    let built = false
    const outcome = await runUpgrade(
      { kind: 'source', projectRoot: '/deploy', restartCommand: ['restart'] },
      'stable',
      'task-1',
      {
        git: async () => 'Already up to date.',
        readTextFile: (() => {
          let call = 0
          return async () => { call += 1; return call === 1 ? 'before' : 'after' }
        })(),
        runCommand: async (argv) => {
          if (argv[0] === 'pnpm' && argv[1] === 'install') throw new Error('offline install failed')
          built = true
        },
        spawnDetached: () => { throw new Error('spawnDetached must not be called after a failed install') },
      },
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.detail).toContain('pnpm install --offline --frozen-lockfile failed')
    expect(built).toBe(false)
  })

  it('falls back to the error message when the thrown error carries no stderr', async () => {
    const outcome = await runUpgrade(
      { kind: 'source', projectRoot: '/deploy', restartCommand: ['restart'] },
      'stable',
      'task-1',
      {
        git: async () => { throw new Error('ENOENT: no such file or directory') },
        runCommand: async () => { throw new Error('runCommand must not be called after a failed merge') },
        spawnDetached: () => { throw new Error('spawnDetached must not be called after a failed merge') },
      },
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.detail).toContain('ENOENT: no such file or directory')
  })

  it('stringifies a thrown value that carries neither stderr nor a message', async () => {
    const outcome = await runUpgrade(
      { kind: 'source', projectRoot: '/deploy', restartCommand: ['restart'] },
      'stable',
      'task-1',
      {
        git: async () => { throw { code: 'WEIRD_FAILURE' } },
        runCommand: async () => { throw new Error('runCommand must not be called after a failed merge') },
        spawnDetached: () => { throw new Error('spawnDetached must not be called after a failed merge') },
      },
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.detail).toContain('git merge --ff-only stable failed')
  })

  it('calls the real default exit (process.exit mocked) when exit is not injected', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    try {
      root = await mkdtemp(join(tmpdir(), 'self-dev-chat-upgrade-'))
      const logPath = join(root, 'invocations.log')
      await installFakeToolchain(root, logPath)
      await writeFile(join(root, 'pnpm-lock.yaml'), 'unchanged\n', 'utf8')
      delete process.env.GIT_TOUCH_LOCKFILE
      const outcome = await runUpgrade(
        { kind: 'source', projectRoot: root, restartCommand: ['restart'] },
        'stable',
        'task-1',
        // Only spawnDetached and scheduleExit are injected (spawnDetached to
        // avoid actually spawning the fake "restart" — no such script exists
        // here — and scheduleExit to run its callback immediately instead of
        // after the real 2-second delay); exit uses its real default, which
        // calls the mocked process.exit above instead of really exiting.
        { spawnDetached: () => {}, scheduleExit: (run) => { run() } },
      )
      expect(outcome.ok).toBe(true)
      expect(exitSpy).toHaveBeenCalledWith(0)
    } finally {
      exitSpy.mockRestore()
    }
  })

  it('uses the real detached spawn and the real scheduled exit by default, calling only the injected exit function', async () => {
    // Only `exit` is injected here — `spawnDetached` and `scheduleExit` use
    // their real defaults, so this proves that wiring works end to end, not
    // only the two functions in isolation (see the `default*` tests below).
    // The real `defaultScheduleExit`'s unref'd timer is harmless to leave
    // pending past this test: it only calls the injected no-op `exit`.
    root = await mkdtemp(join(tmpdir(), 'self-dev-chat-upgrade-'))
    const logPath = join(root, 'invocations.log')
    await installFakeToolchain(root, logPath)
    await writeFile(join(root, 'pnpm-lock.yaml'), 'unchanged\n', 'utf8')
    delete process.env.GIT_TOUCH_LOCKFILE
    const restartScript = join(root, 'restart.sh')
    await writeFile(restartScript, '#!/bin/sh\nexit 0\n', 'utf8')
    await chmod(restartScript, 0o700)

    const outcome = await runUpgrade(
      { kind: 'source', projectRoot: root, restartCommand: [restartScript] },
      'stable',
      'task-1',
      { exit: () => {} },
    )
    expect(outcome.ok).toBe(true)
  })
})

describe('defaultRunCommand, defaultSpawnDetached, and defaultScheduleExit', () => {
  it('defaultRunCommand throws when argv names no program', async () => {
    await expect(defaultRunCommand([], '/tmp')).rejects.toThrow('command must name a program')
  })

  it('defaultSpawnDetached throws when the command names no program', () => {
    expect(() =>{  defaultSpawnDetached([], undefined) }).toThrow('command must name a program')
  })

  it('defaultScheduleExit fires the callback after a real, short delay', async () => {
    let fired = false
    defaultScheduleExit(() => { fired = true }, 10)
    expect(fired).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(fired).toBe(true)
  })
})

describe('upgradeViolation', () => {
  it('accepts every valid kind and rejects an invalid source or launcher config', () => {
    expect(upgradeViolation({ kind: 'none' })).toBeUndefined()
    expect(upgradeViolation({ kind: 'source', projectRoot: '/deploy', restartCommand: ['x'] })).toBeUndefined()
    expect(upgradeViolation({ kind: 'launcher', dshUpgradeBin: 'dsh-upgrade' })).toBeUndefined()
    expect(upgradeViolation({ kind: 'source', projectRoot: '', restartCommand: ['x'] })).toContain('projectRoot')
    expect(upgradeViolation({ kind: 'source', projectRoot: '/deploy', restartCommand: [] })).toContain('restartCommand')
    expect(upgradeViolation({ kind: 'launcher', dshUpgradeBin: '' })).toContain('dshUpgradeBin')
  })
})
