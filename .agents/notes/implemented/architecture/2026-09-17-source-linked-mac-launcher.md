# Agent Note: Source-linked macOS launcher candidates

Status: implemented

English | [中文](2026-09-17-source-linked-mac-launcher.zh.md)

## Problem

The macOS launcher needs a repeatable candidate build that a human can trial alongside the installed App, while the runtime stays owned by the source checkout. The build must include the complete Swift package, distinguish candidate activation and diagnostics, and preserve existing output destinations.

## Decision

### SwiftPM owns the build

`deliverables/mac-launcher/build.sh` builds the `LauncherApp` product with SwiftPM and locates the binary through `--show-bin-path`; both operations use an absolute `--package-path` derived from the script location. Package.swift owns module layout and the macOS 13 deployment target. The working directory does not affect package resolution. SwiftPM sandbox restrictions and other build failures return nonzero without a weaker fallback.

### Candidate identity is distinct

The build copies Info.plist and rewrites it with PlistBuddy: bundle identifier `com.local.deepseek-harness-launcher.candidate`, display name `DeepSeek Harness (Candidate)`, bundle directory `DeepSeek Harness (Candidate).app`. Info.plist keeps the stable `com.local.deepseek-harness-launcher` identifier, and build.sh refuses to run when it does not. The distinct identifier separates LaunchServices activation, TCC permission, and diagnostics; the App derives its log file name from `Bundle.main.bundleIdentifier`, so the candidate writes to `~/Library/Logs/com.local.deepseek-harness-launcher.candidate.log` and never truncates the installed App's log.

### Source-linked configuration

The candidate records absolute paths only: project directory, Node executable, and the CLI entry resolved from `apps/cli/package.json`'s `bin.dsh` (the only supported entry). Node serializes `launcher-config.json` with JSON.stringify, so no path value can inject JSON structure. The App runs `node <entry> web --no-open` from that checkout; the candidate is not a frozen runtime.

### Fail-closed delivery

Paths must be absolute. Project and Node inputs must exist; the destination must not exist, including as a symlink. A private staging directory on the destination volume holds the signed bundle. The build-only `publish-rename.c` helper uses `renamex_np(..., RENAME_EXCL)` for atomic no-replace publication; an existing destination remains untouched, including when another publisher creates it concurrently. The helper is compiled with the host Command Line Tools and is not shipped in the bundle. Explicit outputs require an existing non-symlink parent; default output creates `.build` after input validation. Cleanup removes only private staging. The published directory and candidate identifier are checked before reporting success. Building never installs or replaces an App.

### Runtime ownership and readiness

The launcher owns only the child it spawned: SIGTERM first, SIGKILL after a bounded grace, and it never signals a pre-existing backend. Readiness requires the `dsh web:` readiness line and a cookie-free, redirect-disabled probe: the bare request must return 401 and the tokenized request 303. The requests run concurrently; cookie headers are not validated. A failure phase is terminal: the dialog names it, and quit-and-reopen is the recovery; there is no hidden retry. Candidate identity does not isolate Harness data or filesystem access; the [trial instructions](../../../../deliverables/mac-launcher/README.md) require an explicit fresh data home and loopback port allocation.

## Existing decisions and supersession

[One dsh launcher for application profiles](2026-08-22-single-dsh-application-launcher.md) owns which entries may launch Node applications; this candidate launches `dsh web`, inside that inventory, and the note keeps its authority. No active note is superseded by this decision.

## Alternatives considered

**Keep a flat swiftc source list.** Rejected: a separately maintained list can omit package sources or misrepresent module imports and platform targets.

**Use `mv -n` at publication.** Rejected: it can return success without publishing, or nest the source inside an existing destination directory. Checking whether staging disappeared does not distinguish nesting from publication at the intended path.

**Reuse the stable bundle identifier and ask the tester to quit the installed App first.** Rejected: with a shared identifier, LaunchServices activates the already-running installed instance and macOS shares the Documents permission by identifier, so a trial could silently exercise the wrong binary.

**Fall back to `--disable-sandbox` when SwiftPM's manifest sandbox fails.** Rejected: matching an error message must not authorize weaker build confinement. The caller chooses a host context that supports SwiftPM's sandbox.

## Consequences

- A candidate works only while the recorded checkout, Node executable, and CLI entry stay at their recorded absolute paths, and `apps/cli/lib` stays built.
- The binary compiles at the build machine's architecture under the macOS 13 deployment target; a trial happens on the machine that built the candidate.
- A host that cannot run SwiftPM's sandbox-exec manifest jail cannot build a candidate from inside it; the build must be rerun in a permitted host context.
- `tests/run-build-tests.sh` guards the delivery contract: destination rejections with sentinels intact, symlink rejection, relative and nonexistent input rejection, manifest resolution, build-failure cleanup, the real publication operation of `publish-rename.c` against an existing file, directory, and symlink (sentinels unchanged, no extra children, competing publishers yielding one winner), hermetic builds from the repository root and from an unrelated working directory with quoting-heavy paths, and a real candidate's identity, signature, target, and configuration.

## Testing

- `zsh deliverables/mac-launcher/tests/run-build-tests.sh` covers the rejection, failure, publication-helper, hermetic, and valid-candidate cases described above; the valid-candidate case requires the `LauncherApp` target to compile, which needs a host context that permits SwiftPM's sandbox-exec manifest jail.
- `swift run --package-path deliverables/mac-launcher LauncherTests` covers parsing, redaction, configuration, HTTP probes, and child lifecycle.
- `pnpm run verify-translation-pairing deliverables/mac-launcher/README.md` checks the README pair against its recorded source hashes.
