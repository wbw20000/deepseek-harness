# Agent Note: Frozen macOS candidate runtime

Status: implemented

English | [中文](2026-09-17-frozen-mac-launcher.zh.md)

## Problem

A source-linked launcher fails when its checkout or global Node is moved or damaged. A separately trialled candidate needs runnable bytes and data that development does not overwrite.

## Decision

An opt-in frozen candidate carries independent byte copies of a prepared dsh dependency directory and standalone Node. It retains the Swift AppKit lifecycle owner and launches the supported `dsh web` profile. The build does not install dependencies or replace an existing App. Atomic no-replace publication and a distinct frozen bundle identifier separate a trial from the installed launcher.

Resources contain the runtime, Node, launch overlay, configuration, and a SHA-256 inventory. Internal links are materialized and external links are refused; copies cannot share writable inodes with source inputs. Native files are signed before inventory hashes are recorded. Swift validates the exact file set, size, permission bits, digest, and link count before Node starts. Metadata reads are regular-file-only and bounded; validation is cancellable off the main actor. Bundle identity selects frozen mode even when configuration is damaged, so missing metadata cannot trigger source-linked fallback.

The build records an explicit fresh data home without copying user data. The frozen child uses it as both `DSH_HOME` and working directory; UNIX `HOME` remains unchanged. This avoids ambient invocation-directory `.env` loading while preserving OS home semantics. A bundled overlay chooses an OS-assigned loopback port. Environment hygiene removes Node/dyld injection and secret-like names; it is not confinement.

## Alternatives considered

Source links and hardlinks cannot preserve runnable bytes when a developer changes their target. Materialized copies use more disk space but remove that dependency. A generic dependency resolver inside the launcher would add network and package-install failure paths to startup; the builder therefore accepts a separately prepared, verified dependency directory.

## Consequences

The inventory detects accidental corruption, not a hostile actor able to replace both metadata and payload. Ad-hoc signing is local execution support, not notarization or human release approval. The candidate has ordinary user privileges; recovery copies, storage quotas, network restrictions, and unattended iteration require separate mechanisms. Building or passing tests never authorizes an upgrade.

## Existing decisions

The [source-linked launcher decision](2026-09-17-source-linked-mac-launcher.md) remains active for default mode, publication, and process ownership. Frozen mode adds a separate configuration without superseding that option. The [single dsh launcher decision](2026-08-22-single-dsh-application-launcher.md) remains authoritative for the Node entry. No active note qualifies for archival.

## Verification

The [launcher checks](../../../../deliverables/mac-launcher/README.md#tests) cover invalid metadata, changed bytes and permissions, link rejection, cancellation, stale completion, child environment, build publication, and materialized input independence. An opt-in smoke exercises the actual bundled backend through the Swift controller, including stop and reopen. Native window and browser trials remain separate from headless evidence. A detached-runtime check must deny access to source checkouts and global Node, with a negative control confirming those denials, before claiming independence for a particular artifact.
