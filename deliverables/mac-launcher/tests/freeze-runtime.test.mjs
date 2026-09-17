// Owner-local node:test suite for the build-only frozen materializer. Every
// test works inside fresh private mkdtemp fixture directories and removes
// exactly those directories through the test context's after callbacks, so a
// failing assertion cannot leak fixtures. No test touches the real user's DSH
// home, the repository's runtime inputs, or the network; `otool` and
// `codesign` are PATH shims so the materializer's logic is exercised without
// the host toolchain, while the Mach-O and execution checks run against real
// system binaries.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const tool = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'freeze-runtime.mjs')
const patchSource = path.join(path.dirname(tool), 'frozen-loopback.patch.yml')
const SYSTEM_DEP_LINE = '/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1.0.0)'

function makeFixtureRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freeze-runtime-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function makeRuntime(root, { withEntry = true, binDsh = 'lib/bin.js' } = {}) {
  const runtime = path.join(root, 'deployed-runtime')
  fs.mkdirSync(path.join(runtime, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(runtime, 'package.json'), JSON.stringify({ name: 'dsh', bin: { dsh: binDsh } }))
  if (withEntry) fs.writeFileSync(path.join(runtime, 'lib', 'bin.js'), '#!/usr/bin/env node\n')
  return runtime
}

// The success fixtures compile a real Mach-O executable that answers
// --version with only system dependencies: the runner's own Node binary is
// often a Homebrew-style standalone that loads @rpath/libnode, which the
// materializer must reject, and a shell shim is rejected as well.
const NODE_FIXTURE_SOURCE = '#include <stdio.h>\n' +
  'int main(void) { printf("v0.0.0-freeze-fixture\\n"); return 0; }\n'

function makeOkNodeBinary(root) {
  const binary = path.join(root, 'node-binary')
  const compiled = spawnSync('cc', ['-o', binary, '-x', 'c', '-'], {
    input: NODE_FIXTURE_SOURCE,
    encoding: 'utf8',
    timeout: 60_000,
  })
  if (compiled.status !== 0) {
    throw new Error(`the test fixture Node could not be compiled: ${compiled.stderr}`)
  }
  fs.chmodSync(binary, 0o755)
  return binary
}

// A real Mach-O executable that exits nonzero without answering --version.
function makeSilentFailingNodeBinary(root) {
  const binary = path.join(root, 'node-binary')
  fs.copyFileSync('/usr/bin/false', binary)
  fs.chmodSync(binary, 0o755)
  return binary
}

function makeScriptNodeBinary(root, body = '#!/bin/sh\necho v24.17.0\n') {
  const binary = path.join(root, 'node-binary')
  fs.writeFileSync(binary, body, { mode: 0o755 })
  return binary
}

function makeEmptyHome(root) {
  const home = path.join(root, 'trial-home')
  fs.mkdirSync(home)
  return home
}

// Writes PATH shims for the build-only tools. `otool` cats a prepared
// response file, so each test controls the exact multi-arch output the
// materializer must parse.
function makeShims(root, { codesign = '#!/bin/sh\nexit 0\n', otoolOutput = `${SYSTEM_DEP_LINE}\n` } = {}) {
  const shim = path.join(root, 'shim')
  fs.mkdirSync(shim, { recursive: true })
  fs.writeFileSync(path.join(shim, 'codesign'), codesign, { mode: 0o755 })
  const response = path.join(root, 'otool-response.txt')
  fs.writeFileSync(response, otoolOutput)
  fs.writeFileSync(path.join(shim, 'otool'), `#!/bin/sh\ncat '${response}'\n`, { mode: 0o755 })
  return shim
}

// A codesign shim that imitates a signature changing Mach-O bytes: it appends
// a byte to each signed thin-arm64 Mach-O file except the bundled Node, which
// must stay runnable for the execution check.
const APPENDING_CODESIGN_SHIM = [
  '#!/bin/sh',
  'if [ "$1" = "--verify" ]; then exit 0; fi',
  'for last in "$@"; do :; done',
  'case "$last" in */node/node) exit 0 ;; esac',
  'magic=$(head -c 4 "$last" | od -An -tx1 | tr -d " \\n")',
  'if [ -f "$last" ] && [ "$magic" = "cffaedfe" ]; then printf X >> "$last"; fi',
  'exit 0',
  '',
].join('\n')

function multiArchOtoolOutput(dependencyLinesByArchitecture) {
  return Object.entries(dependencyLinesByArchitecture)
    .map(([architecture, dependencyLines]) =>
      `/otool-fixture (architecture ${architecture}):\n${dependencyLines.map((line) => `\t${line}`).join('\n')}\n`)
    .join('\n')
}

// Runs the materializer as a subprocess with the shim directory prepended to
// PATH and a hard timeout, so a hung materialization cannot wedge the suite.
function run(root, args, extraPath = '') {
  const resources = path.join(root, 'Resources')
  fs.mkdirSync(resources, { recursive: true })
  const result = spawnSync(process.execPath, [tool, 'materialize', ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, PATH: `${extraPath ? `${extraPath}:` : ''}${process.env.PATH}` },
  })
  if (result.signal) throw new Error(`freeze-runtime.mjs hung and was killed (${result.signal})`)
  return { resources, status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function materialize(root, { runtime, node, home, resources, codesign, otoolOutput } = {}) {
  const extraPath = makeShims(root, { codesign, otoolOutput })
  return run(root, [
    '--runtime', runtime ?? makeRuntime(root),
    '--node', node ?? makeOkNodeBinary(root),
    '--resources', resources ?? path.join(root, 'Resources'),
    '--dsh-home', home ?? makeEmptyHome(root),
    '--source-rev', 'abc123',
    '--lockfile-digest', 'a'.repeat(64),
  ], extraPath)
}

// A thin Mach-O executable compiled per fixture, so the Mach-O detection and
// signing behavior run against real Mach-O bytes with system-only
// dependencies.
function makeNativeMachOFile(runtime, relative = 'lib/native') {
  const compiled = spawnSync('cc', ['-o', path.join(runtime, relative), '-x', 'c', '-'], {
    input: 'int main(void) { return 0; }\n',
    encoding: 'utf8',
    timeout: 60_000,
  })
  if (compiled.status !== 0) {
    throw new Error(`the test fixture Mach-O file could not be compiled: ${compiled.stderr}`)
  }
}

function sha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

test('materializes runtime and node with preserved modes and a correct config', (t) => {
  const root = makeFixtureRoot(t)
  const runtime = makeRuntime(root)
  fs.mkdirSync(path.join(runtime, 'node_modules/pkg'), { recursive: true })
  fs.writeFileSync(path.join(runtime, 'node_modules/pkg/index.js'), 'module.exports = 1\n', { mode: 0o644 })
  fs.writeFileSync(path.join(runtime, 'lib', 'run.sh'), '#!/bin/sh\n', { mode: 0o755 })
  const home = makeEmptyHome(root)
  const result = materialize(root, { runtime, home })
  assert.equal(result.status, 0, result.stderr)

  assert.equal(fs.readFileSync(path.join(result.resources, 'runtime/lib/bin.js'), 'utf8'), '#!/usr/bin/env node\n')
  assert.equal(fs.statSync(path.join(result.resources, 'runtime/lib/run.sh')).mode & 0o777, 0o755)
  assert.equal(fs.statSync(path.join(result.resources, 'runtime/node_modules/pkg/index.js')).mode & 0o777, 0o644)
  const copiedNode = path.join(result.resources, 'node/node')
  assert.ok((fs.statSync(copiedNode).mode & 0o111) !== 0, 'the copied Node keeps its executable bits')

  const config = JSON.parse(fs.readFileSync(path.join(result.resources, 'frozen-launcher-config.json'), 'utf8'))
  assert.deepEqual(config, {
    mode: 'frozen',
    runtimeDirectory: 'runtime',
    nodePath: 'node/node',
    dshEntryPath: 'lib/bin.js',
    dshHome: home,
    patchPath: 'frozen-loopback.patch.yml',
    sourceRevision: 'abc123',
    lockfileDigest: 'a'.repeat(64),
    inventoryFile: 'runtime-inventory.json',
  })
  assert.equal(
    fs.readFileSync(path.join(result.resources, 'frozen-loopback.patch.yml'), 'utf8'),
    fs.readFileSync(patchSource, 'utf8'))

  // The materializer never rewrites the inputs it copies.
  assert.equal(fs.readFileSync(path.join(runtime, 'lib/bin.js'), 'utf8'), '#!/usr/bin/env node\n')
  assert.equal(fs.readdirSync(home).length, 0, 'the fresh trial home stays empty')
})

test('seals an inventory of the exact file set with correct digests', (t) => {
  const root = makeFixtureRoot(t)
  const result = materialize(root)
  assert.equal(result.status, 0, result.stderr)
  const inventory = JSON.parse(fs.readFileSync(path.join(result.resources, 'runtime-inventory.json'), 'utf8'))
  assert.equal(inventory.version, 1)
  assert.equal(inventory.algorithm, 'sha256')

  const expected = []
  const walk = (directory, relative) => {
    for (const child of fs.readdirSync(directory).sort()) {
      const childPath = path.join(directory, child)
      const childRelative = relative === '' ? child : `${relative}/${child}`
      if (childRelative === 'runtime-inventory.json') continue
      if (fs.statSync(childPath).isDirectory()) { walk(childPath, childRelative); continue }
      expected.push(childRelative)
    }
  }
  walk(result.resources, '')
  assert.deepEqual(inventory.files.map((file) => file.path).sort(), expected.sort())
  for (const file of inventory.files) {
    assert.equal(file.sha256, sha256(path.join(result.resources, file.path)), file.path)
    assert.equal(file.size, fs.statSync(path.join(result.resources, file.path)).size, file.path)
  }
})

test('signs Mach-O payload files and seals digests of the signed bytes', (t) => {
  const root = makeFixtureRoot(t)
  const runtime = makeRuntime(root)
  makeNativeMachOFile(runtime)
  const result = materialize(root, { runtime, codesign: APPENDING_CODESIGN_SHIM })
  assert.equal(result.status, 0, result.stderr)
  assert.match(fs.readFileSync(path.join(result.resources, 'runtime/lib/native'), 'utf8'), /X$/,
    'the shim signed this Mach-O file')
  const inventory = JSON.parse(fs.readFileSync(path.join(result.resources, 'runtime-inventory.json'), 'utf8'))
  const entry = inventory.files.find((file) => file.path === 'runtime/lib/native')
  assert.equal(entry.sha256, sha256(path.join(result.resources, 'runtime/lib/native')),
    'the inventory digests the signed bytes')
})

test('accepts multi-arch otool output when every architecture is system-only', (t) => {
  const root = makeFixtureRoot(t)
  const runtime = makeRuntime(root)
  makeNativeMachOFile(runtime)
  const result = materialize(root, { runtime, otoolOutput: multiArchOtoolOutput({
    x86_64: [SYSTEM_DEP_LINE],
    arm64: [SYSTEM_DEP_LINE],
  }) })
  assert.equal(result.status, 0, result.stderr)
})

test('rejects non-system Mach-O dependencies in runtime files and in Node', (t) => {
  const cases = [
    {
      name: 'a Homebrew dylib in a runtime file',
      otoolOutput: multiArchOtoolOutput({ arm64: ['/opt/homebrew/opt/libfoo/lib/libfoo.dylib (compatibility version 0.0.0, current version 0.0.0)'] }),
      stderr: /non-system Mach-O library/,
    },
    {
      name: 'an unresolved @rpath install name',
      otoolOutput: multiArchOtoolOutput({ arm64: ['@rpath/libbar.dylib (compatibility version 0.0.0, current version 0.0.0)'] }),
      stderr: /non-system Mach-O library/,
    },
    {
      name: 'an unresolved @loader_path install name in the second architecture',
      otoolOutput: multiArchOtoolOutput({
        x86_64: [SYSTEM_DEP_LINE],
        arm64: ['@loader_path/../libbaz.dylib (compatibility version 0.0.0, current version 0.0.0)'],
      }),
      stderr: /non-system Mach-O library/,
    },
  ]
  for (const { name, otoolOutput, stderr } of cases) {
    const root = makeFixtureRoot(t)
    const runtime = makeRuntime(root)
    makeNativeMachOFile(runtime)
    const result = materialize(root, { runtime, otoolOutput })
    assert.equal(result.status, 1, name)
    assert.match(result.stderr, stderr, name)
  }

  // A Node whose own dependencies are not system-only is rejected before any
  // payload is written.
  const nodeRoot = makeFixtureRoot(t)
  const nodeRuntime = makeRuntime(nodeRoot)
  const homebrewNode = makeOkNodeBinary(nodeRoot)
  const nodeResult = materialize(nodeRoot, {
    runtime: nodeRuntime, node: homebrewNode,
    otoolOutput: multiArchOtoolOutput({ arm64: ['/opt/homebrew/opt/node/lib/libnode.dylib (compatibility version 0.0.0, current version 0.0.0)'] }),
  })
  assert.equal(nodeResult.status, 1)
  assert.match(nodeResult.stderr, /non-system Mach-O library/)
  assert.match(nodeResult.stderr, /node-binary/, 'the rejection names the Node input')
  assert.deepEqual(fs.readdirSync(nodeResult.resources), [], 'no payload was written for the rejected Node')
})

test('requires the production Node to be an executable Mach-O binary that answers --version', (t) => {
  const scriptRoot = makeFixtureRoot(t)
  const script = materialize(scriptRoot, { node: makeScriptNodeBinary(scriptRoot) })
  assert.equal(script.status, 1)
  assert.match(script.stderr, /must be a Mach-O binary/)

  const nonExecRoot = makeFixtureRoot(t)
  const nonExecBinary = path.join(nonExecRoot, 'node-binary')
  fs.copyFileSync('/usr/bin/true', nonExecBinary)
  fs.chmodSync(nonExecBinary, 0o644)
  const nonExec = materialize(nonExecRoot, { node: nonExecBinary })
  assert.equal(nonExec.status, 1)
  assert.match(nonExec.stderr, /not executable/)

  const silentRoot = makeFixtureRoot(t)
  const silent = materialize(silentRoot, { node: makeSilentFailingNodeBinary(silentRoot) })
  assert.equal(silent.status, 1)
  assert.match(silent.stderr, /did not answer --version/)

  const okRoot = makeFixtureRoot(t)
  const ok = materialize(okRoot)
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(ok.stdout, /bundled Node reports v0\.0\.0-freeze-fixture/)
})

test('materializes an in-tree symlink as content and rejects escaping, broken links, and cycles', (t) => {
  const insideRoot = makeFixtureRoot(t)
  const insideRuntime = makeRuntime(insideRoot)
  fs.symlinkSync(path.join(insideRuntime, 'lib/bin.js'), path.join(insideRuntime, 'lib/alias.js'))
  const inside = materialize(insideRoot, { runtime: insideRuntime })
  assert.equal(inside.status, 0, inside.stderr)
  assert.equal(fs.readFileSync(path.join(inside.resources, 'runtime/lib/alias.js'), 'utf8'), '#!/usr/bin/env node\n')
  assert.ok(!fs.lstatSync(path.join(inside.resources, 'runtime/lib/alias.js')).isSymbolicLink())

  const escapingRoot = makeFixtureRoot(t)
  const escapingRuntime = makeRuntime(escapingRoot)
  fs.symlinkSync(escapingRoot, path.join(escapingRuntime, 'lib/escape.js'))
  const escaping = materialize(escapingRoot, { runtime: escapingRuntime })
  assert.equal(escaping.status, 1)
  assert.match(escaping.stderr, /escapes/)

  const brokenRoot = makeFixtureRoot(t)
  const brokenRuntime = makeRuntime(brokenRoot)
  fs.symlinkSync(path.join(brokenRuntime, 'lib/absent.js'), path.join(brokenRuntime, 'lib/dangling.js'))
  const broken = materialize(brokenRoot, { runtime: brokenRuntime })
  assert.equal(broken.status, 1)
  assert.match(broken.stderr, /broken symlink/)

  const selfCycleRoot = makeFixtureRoot(t)
  const selfCycleRuntime = makeRuntime(selfCycleRoot)
  fs.symlinkSync('self', path.join(selfCycleRuntime, 'lib/self'))
  const selfCycle = materialize(selfCycleRoot, { runtime: selfCycleRuntime })
  assert.equal(selfCycle.status, 1)
  assert.match(selfCycle.stderr, /symlink cycle/)

  const rootCycleRoot = makeFixtureRoot(t)
  const rootCycleRuntime = makeRuntime(rootCycleRoot)
  fs.symlinkSync('..', path.join(rootCycleRuntime, 'lib/loop-to-root'))
  const rootCycle = materialize(rootCycleRoot, { runtime: rootCycleRuntime })
  assert.equal(rootCycle.status, 1)
  assert.match(rootCycle.stderr, /symlink cycle/)

  const pairCycleRoot = makeFixtureRoot(t)
  const pairCycleRuntime = makeRuntime(pairCycleRoot)
  fs.symlinkSync('b', path.join(pairCycleRuntime, 'a'))
  fs.symlinkSync('a', path.join(pairCycleRuntime, 'b'))
  const pairCycle = materialize(pairCycleRoot, { runtime: pairCycleRuntime })
  assert.equal(pairCycle.status, 1)
  assert.match(pairCycle.stderr, /symlink cycle/)
})

test('rejects special files, traversal entries, and malformed manifests', (t) => {
  const fifoRoot = makeFixtureRoot(t)
  const fifoRuntime = makeRuntime(fifoRoot)
  assert.equal(spawnSync('mkfifo', [path.join(fifoRuntime, 'lib/pipe')]).status, 0)
  const fifo = materialize(fifoRoot, { runtime: fifoRuntime })
  assert.equal(fifo.status, 1)
  assert.match(fifo.stderr, /special file/)

  const traversalRoot = makeFixtureRoot(t)
  const traversalRuntime = makeRuntime(traversalRoot, { withEntry: false, binDsh: '../outside.js' })
  fs.writeFileSync(path.join(traversalRoot, 'outside.js'), 'escape\n')
  const traversal = materialize(traversalRoot, { runtime: traversalRuntime })
  assert.equal(traversal.status, 1)
  assert.match(traversal.stderr, /escapes/)

  const absoluteRoot = makeFixtureRoot(t)
  const absoluteRuntime = makeRuntime(absoluteRoot, { binDsh: '/etc/passwd' })
  const absolute = materialize(absoluteRoot, { runtime: absoluteRuntime })
  assert.equal(absolute.status, 1)
  assert.match(absolute.stderr, /manifest-relative/)

  const missingRoot = makeFixtureRoot(t)
  const missingRuntime = makeRuntime(missingRoot, { withEntry: false, binDsh: 'lib/absent.js' })
  const missing = materialize(missingRoot, { runtime: missingRuntime })
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /does not exist/)

  const noBinRoot = makeFixtureRoot(t)
  const noBinRuntime = path.join(noBinRoot, 'deployed-runtime')
  fs.mkdirSync(noBinRuntime, { recursive: true })
  fs.writeFileSync(path.join(noBinRuntime, 'package.json'), JSON.stringify({ name: 'dsh' }))
  const noBin = materialize(noBinRoot, { runtime: noBinRuntime })
  assert.equal(noBin.status, 1)
  assert.match(noBin.stderr, /bin\.dsh/)
})

test('produces output bytes independent of later input mutations and input hardlinks', (t) => {
  const root = makeFixtureRoot(t)
  const runtime = makeRuntime(root)
  const entrySource = path.join(runtime, 'lib/bin.js')
  fs.writeFileSync(entrySource, 'first\n')
  const twin = path.join(root, 'twin.js')
  fs.linkSync(entrySource, twin)
  const result = materialize(root, { runtime })
  assert.equal(result.status, 0, result.stderr)
  const materializedEntry = path.join(result.resources, 'runtime/lib/bin.js')
  assert.equal(fs.readFileSync(materializedEntry, 'utf8'), 'first\n')
  assert.equal(fs.lstatSync(materializedEntry).nlink, 1, 'materialized files are not hardlinked')

  // Overwriting the input's hardlink twin replaces the shared inode; the
  // materialized copy keeps its own inode and bytes.
  fs.writeFileSync(twin, 'twin-mutated\n')
  assert.equal(fs.readFileSync(entrySource, 'utf8'), 'twin-mutated\n')
  assert.equal(fs.readFileSync(materializedEntry, 'utf8'), 'first\n',
    'input mutation leaves materialized bytes unchanged')

  fs.writeFileSync(materializedEntry, 'output-mutated\n')
  assert.equal(fs.readFileSync(entrySource, 'utf8'), 'twin-mutated\n',
    'output mutation leaves the input unchanged')
})

test('rejects overlapping input locations in both directions, including ancestor-symlink aliases', (t) => {
  const crossingRoot = makeFixtureRoot(t)
  const crossingHome = path.join(crossingRoot, 'home-with-runtime')
  fs.mkdirSync(crossingHome, { recursive: true })
  const crossingRuntime = makeRuntime(path.join(crossingHome, 'nested'))
  const crossing = materialize(crossingRoot, { runtime: crossingRuntime, home: crossingHome })
  assert.equal(crossing.status, 1)
  assert.match(crossing.stderr, /must not contain one another/)

  const runtimeInsideRoot = makeFixtureRoot(t)
  const runtimeResources = path.join(runtimeInsideRoot, 'Resources')
  fs.mkdirSync(path.join(runtimeResources, 'runtime'), { recursive: true })
  const runtimeInside = run(runtimeInsideRoot, [
    '--runtime', path.join(runtimeResources, 'runtime'), '--node', makeOkNodeBinary(runtimeInsideRoot),
    '--resources', runtimeResources, '--dsh-home', makeEmptyHome(runtimeInsideRoot),
    '--source-rev', 'abc123', '--lockfile-digest', 'a'.repeat(64),
  ])
  assert.equal(runtimeInside.status, 1)
  assert.match(runtimeInside.stderr, /--runtime must not live inside the staged bundle Resources/)

  const resourcesInsideRoot = makeFixtureRoot(t)
  const resourcesRuntime = makeRuntime(resourcesInsideRoot)
  const resourcesInsideRuntime = path.join(resourcesRuntime, 'Resources')
  fs.mkdirSync(resourcesInsideRuntime)
  const resourcesInside = materialize(resourcesInsideRoot, {
    runtime: resourcesRuntime, resources: resourcesInsideRuntime,
  })
  assert.equal(resourcesInside.status, 1)
  assert.match(resourcesInside.stderr, /Resources must not live inside --runtime/)

  const homeInsideRoot = makeFixtureRoot(t)
  const homeResources = path.join(homeInsideRoot, 'Resources')
  fs.mkdirSync(homeResources, { recursive: true })
  const homeInsideResources = path.join(homeResources, 'home')
  fs.mkdirSync(homeInsideResources)
  const homeInside = run(homeInsideRoot, [
    '--runtime', makeRuntime(homeInsideRoot), '--node', makeOkNodeBinary(homeInsideRoot),
    '--resources', homeResources, '--dsh-home', homeInsideResources,
    '--source-rev', 'abc123', '--lockfile-digest', 'a'.repeat(64),
  ])
  assert.equal(homeInside.status, 1)
  assert.match(homeInside.stderr, /--dsh-home must not live inside the staged bundle Resources/)

  const homeContainerRoot = makeFixtureRoot(t)
  const homeContainer = path.join(homeContainerRoot, 'home-with-resources')
  fs.mkdirSync(homeContainer, { recursive: true })
  const containedResources = path.join(homeContainer, 'Resources')
  fs.mkdirSync(containedResources)
  const homeContainerResult = run(homeContainerRoot, [
    '--runtime', makeRuntime(homeContainerRoot), '--node', makeOkNodeBinary(homeContainerRoot),
    '--resources', containedResources, '--dsh-home', homeContainer,
    '--source-rev', 'abc123', '--lockfile-digest', 'a'.repeat(64),
  ])
  assert.equal(homeContainerResult.status, 1)
  assert.match(homeContainerResult.stderr, /--dsh-home must not contain the staged bundle Resources/)

  // Alias paths through a symlinked ancestor describe the same real
  // directories, so an aliased runtime and an aliased home inside it still
  // reject each other.
  const aliasRoot = makeFixtureRoot(t)
  const realBase = path.join(aliasRoot, 'real-base')
  const aliasRuntime = makeRuntime(realBase)
  fs.symlinkSync(realBase, path.join(aliasRoot, 'alias-base'))
  const aliasedRuntimePath = path.join(aliasRoot, 'alias-base', 'deployed-runtime')
  const equalHome = path.join(aliasRoot, 'alias-base', 'deployed-runtime')
  const equalIdentity = materialize(aliasRoot, { runtime: aliasedRuntimePath, home: equalHome })
  assert.equal(equalIdentity.status, 1)
  assert.match(equalIdentity.stderr, /must not contain one another/)

  const nestedHome = path.join(aliasRuntime, 'nested-home')
  fs.mkdirSync(nestedHome)
  const nestedAlias = materialize(aliasRoot, {
    runtime: aliasedRuntimePath, home: path.join(aliasRoot, 'alias-base', 'deployed-runtime', 'nested-home'),
  })
  assert.equal(nestedAlias.status, 1)
  assert.match(nestedAlias.stderr, /must not contain one another/)

  const nodeInRuntimeRoot = makeFixtureRoot(t)
  const nodeInRuntime = makeRuntime(nodeInRuntimeRoot)
  const nodeInsideRuntime = makeOkNodeBinary(nodeInRuntime)
  fs.renameSync(nodeInsideRuntime, path.join(nodeInRuntime, 'node-inside'))
  const nodeInRuntimeResult = materialize(nodeInRuntimeRoot, {
    runtime: nodeInRuntime, node: path.join(nodeInRuntime, 'node-inside'),
  })
  assert.equal(nodeInRuntimeResult.status, 1)
  assert.match(nodeInRuntimeResult.stderr, /--node must live outside the --runtime directory/)
})

test('requires an empty staged Resources directory', (t) => {
  const leftoverRoot = makeFixtureRoot(t)
  const leftoverResources = path.join(leftoverRoot, 'Resources')
  fs.mkdirSync(leftoverResources, { recursive: true })
  fs.writeFileSync(path.join(leftoverResources, 'leftover.txt'), 'caller file\n')
  const leftover = materialize(leftoverRoot, { resources: leftoverResources })
  assert.equal(leftover.status, 1)
  assert.match(leftover.stderr, /empty staged Resources/)
  assert.equal(fs.readFileSync(path.join(leftoverResources, 'leftover.txt'), 'utf8'), 'caller file\n',
    'the caller file survives')

  const payloadRoot = makeFixtureRoot(t)
  const payloadResources = path.join(payloadRoot, 'Resources')
  fs.mkdirSync(path.join(payloadResources, 'runtime'), { recursive: true })
  const payload = materialize(payloadRoot, { resources: payloadResources })
  assert.equal(payload.status, 1)
  assert.match(payload.stderr, /empty staged Resources/)
})

test('rejects malformed flag usage and origin arguments', (t) => {
  const baseArgs = (root, overrides = {}) => ([
    '--runtime', overrides.runtime ?? makeRuntime(root),
    '--node', overrides.node ?? makeOkNodeBinary(root),
    '--resources', overrides.resources ?? path.join(root, 'Resources'),
    '--dsh-home', overrides.home ?? makeEmptyHome(root),
    '--source-rev', overrides.sourceRev ?? 'abc123',
    '--lockfile-digest', overrides.digest ?? 'a'.repeat(64),
    ...(overrides.extra ?? []),
  ])

  const unknownRoot = makeFixtureRoot(t)
  const unknown = run(unknownRoot, [...baseArgs(unknownRoot), '--bogus', 'value'])
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /usage:/)

  const duplicateRoot = makeFixtureRoot(t)
  const duplicate = run(duplicateRoot, [...baseArgs(duplicateRoot), '--source-rev', 'again'])
  assert.equal(duplicate.status, 1)
  assert.match(duplicate.stderr, /duplicate flag --source-rev/)

  const missingRoot = makeFixtureRoot(t)
  const missing = run(missingRoot, baseArgs(missingRoot).slice(0, -2))
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /missing required flag --lockfile-digest/)

  const emptyRoot = makeFixtureRoot(t)
  const empty = run(emptyRoot, baseArgs(emptyRoot, { sourceRev: '' }))
  assert.equal(empty.status, 1)
  assert.match(empty.stderr, /--source-rev must be a non-empty string/)

  const newlineRoot = makeFixtureRoot(t)
  const newline = run(newlineRoot, baseArgs(newlineRoot, { sourceRev: 'abc\ndef' }))
  assert.equal(newline.status, 1)
  assert.match(newline.stderr, /control characters/)

  const digestRoot = makeFixtureRoot(t)
  const digest = run(digestRoot, baseArgs(digestRoot, { digest: 'NOT-A-DIGEST' }))
  assert.equal(digest.status, 1)
  assert.match(digest.stderr, /SHA-256 digest/)
})

test('accepts a real bundled rpath library and refuses its missing dependency', (t) => {
  function prepare() {
    const root = makeFixtureRoot(t)
    const runtime = makeRuntime(root)
    const dependencies = path.join(runtime, 'lib/deps')
    fs.mkdirSync(dependencies)
    const library = path.join(dependencies, 'libfixture.dylib')
    const buildLibrary = spawnSync('cc', ['-dynamiclib', '-install_name', '@rpath/libfixture.dylib',
      '-o', library, '-x', 'c', '-'], {
      input: 'int fixture(void) { return 0; }\n', encoding: 'utf8', timeout: 60_000,
    })
    assert.equal(buildLibrary.status, 0, buildLibrary.stderr)
    const buildConsumer = spawnSync('cc', ['-o', path.join(runtime, 'lib/native'),
      '-L', dependencies, '-lfixture', '-Wl,-rpath,@loader_path/deps', '-x', 'c', '-'], {
      input: 'int fixture(void); int main(void) { return fixture(); }\n', encoding: 'utf8', timeout: 60_000,
    })
    assert.equal(buildConsumer.status, 0, buildConsumer.stderr)
    const shim = makeShims(root)
    fs.writeFileSync(path.join(shim, 'otool'), '#!/bin/sh\nexec /usr/bin/otool "$@"\n', { mode: 0o755 })
    const args = [
      '--runtime', runtime, '--node', makeOkNodeBinary(root),
      '--resources', path.join(root, 'Resources'), '--dsh-home', makeEmptyHome(root),
      '--source-rev', 'fixture', '--lockfile-digest', 'a'.repeat(64),
    ]
    return { root, library, shim, args }
  }
  const valid = prepare()
  const accepted = run(valid.root, valid.args, valid.shim)
  assert.equal(accepted.status, 0, accepted.stderr)
  const inventory = JSON.parse(fs.readFileSync(path.join(accepted.resources, 'runtime-inventory.json'), 'utf8'))
  assert.ok(inventory.files.some((file) => file.path === 'runtime/lib/deps/libfixture.dylib'))

  const missing = prepare()
  fs.unlinkSync(missing.library)
  const rejected = run(missing.root, missing.args, missing.shim)
  assert.equal(rejected.status, 1)
  assert.match(rejected.stderr, /non-system Mach-O library @rpath\/libfixture.dylib/)
})
