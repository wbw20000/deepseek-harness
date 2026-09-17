#!/usr/bin/env node
// Build-only materializer for the frozen macOS candidate. build.sh invokes it
// once per build against an explicitly supplied deployed dsh runtime directory
// and a standalone Node binary. It copies both into the staged bundle's
// Resources as independent bytes (no hardlinks to the inputs, no symlinks),
// materializes in-tree symlinks as their target content, rejects runtime trees
// whose Mach-O files depend on anything outside /usr/lib and /System/Library
// (including unresolved @rpath/@loader_path/@executable_path install names),
// seals the bundled launch overlay, re-signs every Mach-O payload file ad hoc,
// verifies the bundled Node executes, and writes the SHA-256 inventory the
// Swift launcher validates before it starts the bundled Node. It resolves
// nothing on its own: every input is an explicit build argument, and any
// rejection exits nonzero; build.sh owns discarding the staged bundle.

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HASH_CHUNK_BYTES = 256 * 1024
const TOOL_TIMEOUT_MS = 60_000
const NODE_VERIFY_TIMEOUT_MS = 60_000
const INVENTORY_VERSION = 1
const INVENTORY_ALGORITHM = 'sha256'
const INVENTORY_FILE_NAME = 'runtime-inventory.json'
const CONFIG_FILE_NAME = 'frozen-launcher-config.json'
const PATCH_FILE_NAME = 'frozen-loopback.patch.yml'
const MACH_O_MAGICS = new Set([
  'cafebabe', 'cafebabf', 'cefaedfe', 'cffaedfe',
  'feedface', 'feedfacf', 'bebafeca', 'bfbafeca',
])
// Node is system-only. Native runtime dependencies may additionally resolve
// through their own loader-relative paths to inventoried Mach-O files.
const SYSTEM_LIBRARY_PREFIXES = ['/usr/lib/', '/System/Library/']
const KNOWN_FLAGS = new Set([
  'runtime', 'node', 'resources', 'dsh-home', 'source-rev', 'lockfile-digest',
])
const USAGE = 'usage: freeze-runtime.mjs materialize --runtime <dir> --node <path> --resources <dir> --dsh-home <dir> --source-rev <string> --lockfile-digest <sha256>'

class BuildError extends Error {}

function fail(message) {
  throw new BuildError(message)
}

function parseArguments(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const name = typeof flag === 'string' && flag.startsWith('--') ? flag.slice(2) : ''
    if (!KNOWN_FLAGS.has(name) || index + 1 >= argv.length) fail(USAGE)
    if (name in values) fail(`duplicate flag --${name}`)
    values[name] = argv[index + 1]
  }
  for (const name of KNOWN_FLAGS) {
    if (!(name in values)) fail(`missing required flag --${name}`)
  }
  return values
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate)
  return relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function assertRealDirectory(value, label) {
  let stats
  try {
    stats = fs.lstatSync(value)
  } catch {
    fail(`${label} does not exist: ${value}`)
  }
  if (stats.isSymbolicLink()) fail(`${label} must not be a symlink: ${value}`)
  if (!stats.isDirectory()) fail(`${label} must be a directory: ${value}`)
}

// Overlap checks compare the directories' identities through realpath, so
// ancestor-symlink aliases of the same location reject each other instead of
// passing as disjoint path strings.
function realIdentity(value, label) {
  try {
    return fs.realpathSync(value)
  } catch (error) {
    fail(`${label} could not be resolved through symlinks: ${error.message}`)
  }
}

function sanitizedChildEnvironment() {
  const environment = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith('DYLD_') || name === 'NODE_OPTIONS' || name === 'NODE_PATH') continue
    environment[name] = value
  }
  return environment
}

function runTool(command, arguments_, label) {
  const result = spawnSync(command, arguments_, {
    env: sanitizedChildEnvironment(),
    encoding: 'buffer',
    maxBuffer: 16 * 1024 * 1024,
    timeout: TOOL_TIMEOUT_MS,
  })
  if (result.error) fail(`${label} could not run: ${result.error.message}`)
  if (result.signal) fail(`${label} was terminated (${result.signal}) before it finished`)
  return result
}

function fileSha256(filePath) {
  const hash = createHash('sha256')
  const descriptor = fs.openSync(filePath, 'r')
  try {
    const chunk = Buffer.alloc(HASH_CHUNK_BYTES)
    for (;;) {
      const read = fs.readSync(descriptor, chunk, 0, chunk.length, null)
      if (read === 0) break
      hash.update(read === chunk.length ? chunk : chunk.subarray(0, read))
    }
  } finally {
    fs.closeSync(descriptor)
  }
  return hash.digest('hex')
}

function isMachO(filePath) {
  const descriptor = fs.openSync(filePath, 'r')
  try {
    const header = Buffer.alloc(4)
    if (fs.readSync(descriptor, header, 0, 4, 0) !== 4) return false
    return MACH_O_MAGICS.has(header.toString('hex'))
  } finally {
    fs.closeSync(descriptor)
  }
}

function normalizedMode(stats) {
  // Preserve permission bits; drop setuid/setgid/sticky so no payload file
  // carries privilege bits it does not need.
  return (stats.mode & 0o777).toString(8).padStart(3, '0')
}

function entryKind(stats, filePath) {
  if (stats.isSymbolicLink()) return 'symlink'
  if (stats.isDirectory()) return 'directory'
  if (stats.isFile()) return 'file'
  fail(`the runtime contains a special file at ${filePath}; only regular files and directories are supported`)
}

function assertInsideRoot(root, candidate, description) {
  if (!isInside(root, candidate)) fail(`${description} escapes ${root}`)
}

function copyTree(sourceRoot, destinationRoot) {
  fs.mkdirSync(destinationRoot, { recursive: true })
  const copiedFiles = []
  const canonicalRoot = fs.realpathSync(sourceRoot)
  // The root itself starts active, so a symlink back to the runtime root is a
  // cycle, not an infinitely recursive copy.
  copyEntry(canonicalRoot, destinationRoot, canonicalRoot, new Set([canonicalRoot]), copiedFiles)
  return copiedFiles
}

function copyEntry(source, destination, sourceRoot, activeRealPaths, copiedFiles) {
  const stats = fs.lstatSync(source)
  const kind = entryKind(stats, source)
  if (kind === 'symlink') {
    const rawTarget = fs.readlinkSync(source)
    const absoluteTarget = path.resolve(path.dirname(source), rawTarget)
    let realTarget
    try {
      realTarget = fs.realpathSync(absoluteTarget)
    } catch {
      // A dangling link has no target entry at all; a link whose target entry
      // exists but cannot be resolved is part of a loop.
      let targetExists = false
      try {
        fs.lstatSync(absoluteTarget)
        targetExists = true
      } catch {
        targetExists = false
      }
      if (targetExists) {
        fail(`the runtime contains a symlink cycle: ${source} -> ${rawTarget}`)
      }
      fail(`the runtime contains a broken symlink: ${source} -> ${rawTarget}`)
    }
    assertInsideRoot(sourceRoot, realTarget, `the symlink ${source} -> ${rawTarget}`)
    if (activeRealPaths.has(realTarget)) fail(`the runtime contains a symlink cycle through ${realTarget}`)
    activeRealPaths.add(realTarget)
    try {
      copyEntry(realTarget, destination, sourceRoot, activeRealPaths, copiedFiles)
    } finally {
      activeRealPaths.delete(realTarget)
    }
    return
  }
  if (kind === 'directory') {
    fs.mkdirSync(destination, { recursive: true })
    fs.chmodSync(destination, stats.mode & 0o777)
    for (const child of fs.readdirSync(source).sort()) {
      copyEntry(path.join(source, child), path.join(destination, child), sourceRoot, activeRealPaths, copiedFiles)
    }
    return
  }
  // Regular file: an explicit read/write copy gives the output its own inode
  // (nlink 1), so later input mutations never change materialized bytes.
  const content = fs.readFileSync(source)
  fs.writeFileSync(destination, content, { mode: stats.mode & 0o777 })
  fs.chmodSync(destination, stats.mode & 0o777)
  if (fs.lstatSync(destination).nlink !== 1) {
    fail(`the materialized file ${destination} is unexpectedly hardlinked (nlink != 1)`)
  }
  copiedFiles.push(destination)
}

function resolveDshEntry(runtimeDirectory) {
  const manifestPath = path.join(runtimeDirectory, 'package.json')
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    fail(`the deployed runtime manifest is missing or not valid JSON (${manifestPath}): ${error.message}`)
  }
  const entry = manifest?.bin?.dsh
  if (typeof entry !== 'string' || entry === '') {
    fail(`the deployed runtime manifest does not declare a bin.dsh string: ${manifestPath}`)
  }
  if (path.isAbsolute(entry)) fail(`bin.dsh must be a manifest-relative path, got: ${entry}`)
  const entryPath = path.resolve(runtimeDirectory, entry)
  assertInsideRoot(runtimeDirectory, entryPath, `bin.dsh (${entry})`)
  if (path.relative(runtimeDirectory, entryPath) === '') fail(`bin.dsh must name a file, not the runtime root: ${entry}`)
  let stats
  try {
    stats = fs.lstatSync(entryPath)
  } catch {
    fail(`the resolved dsh entry does not exist: ${entryPath}`)
  }
  if (stats.isSymbolicLink()) {
    const realEntry = fs.realpathSync(entryPath)
    assertInsideRoot(runtimeDirectory, realEntry, `the dsh entry symlink ${entry}`)
  }
  if (!fs.statSync(entryPath).isFile()) fail(`the resolved dsh entry is not a regular file: ${entryPath}`)
  return path.relative(runtimeDirectory, entryPath).split(path.sep).join('/')
}

function assertMachODependenciesAreSystem(filePath, bundledFiles) {
  const result = runTool('otool', ['-L', filePath], 'otool')
  if (result.status !== 0) {
    fail(`otool -L failed for ${filePath}: ${result.stderr.toString().trim()}`)
  }
  // otool prints one column-0 header per architecture ("path:", or
  // "path (architecture arm64):" for fat binaries) and indents each load
  // command with whitespace. Only indented non-empty lines are dependencies,
  // so a fat binary's second header is never mistaken for one.
  for (const line of result.stdout.toString().split('\n')) {
    if (!/^\s/.test(line)) continue
    const entry = line.trim()
    if (entry === '') continue
    const separator = entry.indexOf(' (')
    const dependency = separator === -1 ? entry.split(/\s+/)[0] : entry.slice(0, separator)
    const allowed = SYSTEM_LIBRARY_PREFIXES.some((prefix) => path.normalize(dependency).startsWith(prefix))
    if (!allowed) {
      if (bundledFiles && dependency.startsWith('@') && bundledDependencyExists(filePath, dependency, bundledFiles)) continue
      fail(`${filePath} depends on non-system Mach-O library ${dependency}; ` +
        'the dependency must be a system library or resolve to an inventoried bundled Mach-O file')
    }
  }
}

function bundledDependencyExists(filePath, dependency, bundledFiles) {
  const result = runTool('otool', ['-l', filePath], 'otool')
  if (result.status !== 0) fail(`otool -l failed for ${filePath}`)
  const commands = result.stdout.toString().split(/Load command \d+\r?\n/).slice(1)
  const installNames = commands.filter((command) => /\bcmd LC_ID_DYLIB\b/.test(command))
    .map((command) => command.match(/\bname (.+) \(offset \d+\)/)?.[1])
  // otool -L includes a dylib's own install name, which is not a load command.
  if (installNames.includes(dependency)) return true
  const loaderPath = (value) => value.startsWith('@loader_path/')
    ? path.resolve(path.dirname(filePath), value.slice('@loader_path/'.length)) : undefined
  let candidates
  if (dependency.startsWith('@loader_path/')) {
    candidates = [loaderPath(dependency)]
  } else if (dependency.startsWith('@rpath/')) {
    const rpaths = commands.filter((command) => /\bcmd LC_RPATH\b/.test(command))
      .map((command) => command.match(/\bpath (.+) \(offset \d+\)/)?.[1])
    // Inherited rpaths and absolute/executable-relative layouts are not
    // supported. Every declared search directory must stay in Resources.
    const roots = rpaths.map((value) => value && loaderPath(value))
    if (roots.some((root) => !root || !isInside(bundledFiles.root, root))) return false
    candidates = roots.map((root) => path.resolve(root, dependency.slice('@rpath/'.length)))
  } else {
    return false
  }
  for (const candidate of candidates) {
    if (!candidate || !isInside(bundledFiles.root, candidate)) return false
    if (!fs.existsSync(candidate)) continue
    // The first existing dyld search result must be one of the copied,
    // audited files; a later valid result cannot conceal an earlier outsider.
    return bundledFiles.paths.has(fs.realpathSync(candidate))
  }
  return false
}

function signMachOFiles(codesignExecutable, files, bundleIdentifier) {
  for (const filePath of files) {
    const relative = filePath.relativePath
    const identifier = `${bundleIdentifier}.runtime.` +
      createHash('sha256').update(relative).digest('hex')
    const result = runTool(codesignExecutable, [
      '--force', '--sign', '-', '--identifier', identifier, filePath.absolutePath,
    ], 'codesign')
    if (result.status !== 0) {
      fail(`codesign failed for ${filePath.absolutePath}: ${result.stderr.toString().trim()}`)
    }
    const verify = runTool(codesignExecutable, ['--verify', filePath.absolutePath], 'codesign')
    if (verify.status !== 0) {
      fail(`codesign --verify failed for ${filePath.absolutePath}: ${verify.stderr.toString().trim()}`)
    }
  }
}

function verifyNodeExecutes(nodePath) {
  const result = spawnSync(nodePath, ['--version'], {
    env: sanitizedChildEnvironment(),
    encoding: 'utf8',
    timeout: NODE_VERIFY_TIMEOUT_MS,
  })
  if (result.error) fail(`the bundled Node could not be executed: ${result.error.message}`)
  if (result.status !== 0 || !result.stdout.startsWith('v')) {
    fail(`the bundled Node did not answer --version (status ${result.status}): ${result.stderr.toString().trim()}`)
  }
  return result.stdout.trim()
}

function buildInventory(resourcesDirectory) {
  const entries = []
  walkInventory(resourcesDirectory, '', entries)
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  return { version: INVENTORY_VERSION, algorithm: INVENTORY_ALGORITHM, files: entries }
}

function walkInventory(resourcesDirectory, relative, entries) {
  for (const child of fs.readdirSync(resourcesDirectory).sort()) {
    const childPath = path.join(resourcesDirectory, child)
    const childRelative = relative === '' ? child : `${relative}/${child}`
    if (childRelative === INVENTORY_FILE_NAME) continue
    const stats = fs.lstatSync(childPath)
    if (stats.isSymbolicLink()) fail(`the payload contains a symlink at ${childRelative}`)
    if (stats.isDirectory()) {
      walkInventory(childPath, childRelative, entries)
      continue
    }
    if (!stats.isFile()) fail(`the payload contains a special file at ${childRelative}`)
    entries.push({
      path: childRelative,
      sha256: fileSha256(childPath),
      size: stats.size,
      mode: normalizedMode(stats),
    })
  }
}

function materialize(values) {
  const runtimeDirectory = values['runtime']
  const nodeBinary = values['node']
  const resourcesDirectory = values['resources']
  const dshHome = values['dsh-home']
  const sourceRevision = values['source-rev']
  const lockfileDigest = values['lockfile-digest']
  if (!runtimeDirectory || !nodeBinary || !resourcesDirectory || !dshHome ||
      typeof sourceRevision !== 'string' || lockfileDigest === undefined) {
    fail(USAGE)
  }
  for (const [value, label] of [[runtimeDirectory, '--runtime'], [nodeBinary, '--node'], [resourcesDirectory, '--resources'], [dshHome, '--dsh-home']]) {
    if (!path.isAbsolute(value)) fail(`${label} must be an absolute path, got: ${value}`)
  }
  if (sourceRevision === '') fail('--source-rev must be a non-empty string')
  if (/[\u0000-\u001f]/.test(sourceRevision)) fail('--source-rev must not contain control characters')
  if (!/^[0-9a-f]{64}$/.test(lockfileDigest)) fail('--lockfile-digest must be a lowercase 64-character SHA-256 digest')

  assertRealDirectory(runtimeDirectory, '--runtime')
  assertRealDirectory(dshHome, '--dsh-home')
  assertRealDirectory(resourcesDirectory, '--resources')
  const realRuntime = realIdentity(runtimeDirectory, '--runtime')
  const realResources = realIdentity(resourcesDirectory, '--resources')
  const realHome = realIdentity(dshHome, '--dsh-home')
  if (isInside(realResources, realRuntime)) fail('--runtime must not live inside the staged bundle Resources')
  if (isInside(realRuntime, realResources)) fail('the staged bundle Resources must not live inside --runtime')
  if (isInside(realRuntime, realHome) || isInside(realHome, realRuntime)) {
    fail('--dsh-home and --runtime must not contain one another')
  }
  if (isInside(realHome, realResources)) fail('--dsh-home must not contain the staged bundle Resources')
  if (isInside(realResources, realHome)) fail('--dsh-home must not live inside the staged bundle Resources')

  let nodeStats
  try {
    nodeStats = fs.lstatSync(nodeBinary)
  } catch {
    fail(`--node does not exist: ${nodeBinary}`)
  }
  if (nodeStats.isSymbolicLink()) fail(`--node must be the standalone binary itself, not a symlink: ${nodeBinary}`)
  if (!nodeStats.isFile()) fail(`--node must be a regular file: ${nodeBinary}`)
  if ((nodeStats.mode & 0o111) === 0) fail(`--node is not executable: ${nodeBinary}`)
  const realNode = realIdentity(nodeBinary, '--node')
  if (isInside(realRuntime, realNode)) fail(`--node must live outside the --runtime directory: ${nodeBinary}`)
  if (isInside(realResources, realNode)) fail(`--node must live outside the staged bundle Resources: ${nodeBinary}`)
  // A shell shim that prints a version string is not production Node: the
  // payload must carry a real Mach-O binary whose own dependencies are
  // system-only.
  if (!isMachO(nodeBinary)) fail(`--node must be a Mach-O binary, not a script: ${nodeBinary}`)
  assertMachODependenciesAreSystem(nodeBinary)

  if (fs.readdirSync(dshHome).length > 0) fail(`--dsh-home must be an empty fresh trial home: ${dshHome}`)

  const dshEntryRelative = resolveDshEntry(runtimeDirectory)

  // The staged Resources must be a fresh empty directory: the materializer
  // never adds to, overwrites, or deletes caller files there.
  if (fs.readdirSync(resourcesDirectory).length > 0) {
    fail(`--resources must be an empty staged Resources directory, refusing an existing payload: ${resourcesDirectory}`)
  }
  const runtimeDestination = path.join(resourcesDirectory, 'runtime')
  const runtimeFiles = copyTree(runtimeDirectory, runtimeDestination)
    .map((absolutePath) => ({ absolutePath, relativePath: path.relative(resourcesDirectory, absolutePath).split(path.sep).join('/') }))

  const nodeDestinationDirectory = path.join(resourcesDirectory, 'node')
  fs.mkdirSync(nodeDestinationDirectory, { mode: 0o755 })
  const nodeDestination = path.join(nodeDestinationDirectory, 'node')
  fs.writeFileSync(nodeDestination, fs.readFileSync(nodeBinary), { mode: nodeStats.mode & 0o777 })
  fs.chmodSync(nodeDestination, nodeStats.mode & 0o777)
  if ((fs.lstatSync(nodeDestination).mode & 0o111) === 0) fail(`the copied Node lost its executable bits: ${nodeDestination}`)

  fs.copyFileSync(path.join(fileURLToPath(new URL('.', import.meta.url)), PATCH_FILE_NAME),
    path.join(resourcesDirectory, PATCH_FILE_NAME))

  fs.writeFileSync(path.join(resourcesDirectory, CONFIG_FILE_NAME), JSON.stringify({
    mode: 'frozen',
    runtimeDirectory: 'runtime',
    nodePath: 'node/node',
    dshEntryPath: dshEntryRelative,
    dshHome,
    patchPath: PATCH_FILE_NAME,
    sourceRevision,
    lockfileDigest,
    inventoryFile: INVENTORY_FILE_NAME,
  }, null, 2) + '\n', { mode: 0o644 })

  // Audit the whole native file set before signing, including the dependency
  // files reached through each loader's own rpaths.
  const machOFiles = runtimeFiles.filter((file) => isMachO(file.absolutePath))
  const bundledFiles = {
    root: fs.realpathSync(resourcesDirectory),
    paths: new Set(machOFiles.map((file) => fs.realpathSync(file.absolutePath))),
  }
  for (const file of machOFiles) {
    assertMachODependenciesAreSystem(fs.realpathSync(file.absolutePath), bundledFiles)
  }
  const bundleIdentifier = 'com.local.deepseek-harness-launcher.candidate.frozen'
  signMachOFiles('codesign', [...machOFiles, { absolutePath: nodeDestination, relativePath: 'node/node' }], bundleIdentifier)

  const nodeVersion = verifyNodeExecutes(nodeDestination)

  const inventory = buildInventory(resourcesDirectory)
  fs.writeFileSync(path.join(resourcesDirectory, INVENTORY_FILE_NAME),
    JSON.stringify(inventory, null, 2) + '\n', { mode: 0o644 })

  process.stdout.write(`materialized ${runtimeFiles.length} runtime files and 1 Node binary\n`)
  process.stdout.write(`signed ${machOFiles.length + 1} Mach-O payload files\n`)
  process.stdout.write(`bundled Node reports ${nodeVersion}\n`)
  process.stdout.write(`inventory: ${inventory.files.length} files sealed in ${INVENTORY_FILE_NAME}\n`)
}

const [command, ...rest] = process.argv.slice(2)
try {
  if (command !== 'materialize') {
    fail(USAGE)
  }
  materialize(parseArguments(rest))
} catch (error) {
  process.stderr.write(`freeze-runtime.mjs: ${error instanceof BuildError ? error.message : String(error)}\n`)
  process.exit(1)
}
