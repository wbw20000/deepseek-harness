#!/bin/zsh
# Build, sign, and verify an opt-in candidate launcher bundle through
# SwiftPM. This script never installs: the output path must not exist, there is
# no Desktop default, and no installed App is ever replaced. The candidate
# carries its own bundle identifier and display name, so LaunchServices, TCC,
# and diagnostics can never confuse it with the installed App. Publication is
# an atomic no-replace rename performed by a build-only helper compiled into
# the private staging directory; the helper is never shipped in the bundle.

set -euo pipefail

script_directory=${0:A:h}
stable_bundle_identifier="com.local.deepseek-harness-launcher"
candidate_bundle_identifier="${stable_bundle_identifier}.candidate"
candidate_display_name="DeepSeek Harness (Candidate)"
frozen_bundle_identifier="${candidate_bundle_identifier}.frozen"
frozen_display_name="DeepSeek Harness (Frozen Candidate)"
bundle_directory_name="${candidate_display_name}.app"
frozen_bundle_directory_name="${frozen_display_name}.app"
executable_name="DeepSeek Harness"
swiftpm_product="LauncherApp"
default_output="${script_directory}/.build/${bundle_directory_name}"
frozen_default_output="${script_directory}/.build/${frozen_bundle_directory_name}"
freeze_tool="${script_directory}/tools/freeze-runtime.mjs"
plist_buddy="/usr/libexec/PlistBuddy"

project_directory=""
node_executable=""
output_path="$default_output"
output_is_default=1
frozen=0
runtime_directory=""
dsh_home=""
source_revision=""
lockfile_digest=""
bundle_identifier="$candidate_bundle_identifier"
display_name="$candidate_display_name"

usage() {
  print -u2 "usage: build.sh --project-dir <absolute path to the dsh checkout> --node <absolute path to node> [--output <absolute path to the new .app>]"
  print -u2 "  source-linked (default): records the checkout's absolute paths; the candidate runs that checkout's built CLI."
  print -u2 "  frozen:                  add --frozen --runtime-dir <deployed dsh directory> --dsh-home <fresh empty trial home> --source-rev <string> --lockfile-digest <sha256>; --node must be a standalone Node binary."
  print -u2 "  --output (both modes):   absolute path to the new .app; default ${default_output} or ${frozen_default_output}; refuses to overwrite anything."
  exit 2
}

fail() {
  print -u2 "build.sh: $1"
  exit 1
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --project-dir)
      [[ $# -ge 2 ]] || usage
      project_directory=$2
      shift 2
      ;;
    --node)
      [[ $# -ge 2 ]] || usage
      node_executable=$2
      shift 2
      ;;
    --output)
      [[ $# -ge 2 ]] || usage
      output_path=$2
      output_is_default=0
      shift 2
      ;;
    --frozen)
      frozen=1
      shift
      ;;
    --runtime-dir)
      [[ $# -ge 2 ]] || usage
      runtime_directory=$2
      shift 2
      ;;
    --dsh-home)
      [[ $# -ge 2 ]] || usage
      dsh_home=$2
      shift 2
      ;;
    --source-rev)
      [[ $# -ge 2 ]] || usage
      source_revision=$2
      shift 2
      ;;
    --lockfile-digest)
      [[ $# -ge 2 ]] || usage
      lockfile_digest=$2
      shift 2
      ;;
    *)
      usage
      ;;
  esac
done

[[ $frozen == 1 || -n $project_directory ]] || usage
[[ -n $node_executable ]] || usage

# Every input must be an absolute path: the emitted configuration is consumed
# from an App bundle whose working directory is not this checkout.
if [[ $frozen == 1 ]]; then
  [[ -n $runtime_directory && -n $dsh_home && -n $source_revision && -n $lockfile_digest ]] \
    || fail "--frozen requires --runtime-dir, --dsh-home, --source-rev, and --lockfile-digest"
  [[ -z $project_directory ]] || fail "--project-dir is not a frozen build input; pass --runtime-dir instead"
  [[ -f $freeze_tool ]] || fail "the freeze tool is missing: $freeze_tool"
  if [[ $output_is_default == 1 ]]; then output_path="$frozen_default_output"; fi
  bundle_identifier="$frozen_bundle_identifier"
  display_name="$frozen_display_name"
  [[ $source_revision != *$'\n'* && -n $source_revision ]] || fail "--source-rev must be a non-empty single-line string"
  [[ $lockfile_digest =~ ^[0-9a-f]{64}$ ]] || fail "--lockfile-digest must be a lowercase 64-character SHA-256 digest"
  for value in "$runtime_directory" "$dsh_home" "$node_executable" "$output_path"; do
    [[ $value = /* ]] || fail "paths must be absolute, got: $value"
  done
  [[ ! -L $runtime_directory && -d $runtime_directory ]] || fail "runtime directory must be a real directory, not a symlink: $runtime_directory"
  [[ -d $dsh_home && ! -L $dsh_home ]] || fail "dsh home must be a real directory, not a symlink: $dsh_home"
  default_dsh_home="${HOME}/.dsh"
  [[ ${dsh_home:A} != ${default_dsh_home:A} ]] || fail "--dsh-home must not be the default harness home ${default_dsh_home}; create a fresh empty trial home"
else
  for value in "$project_directory" "$node_executable" "$output_path"; do
    [[ $value = /* ]] || fail "paths must be absolute, got: $value"
  done
fi

# An explicit --output keeps the caller's responsibility for its parent; the
# default output's .build parent is created after all input validation.
output_parent=${output_path:h}
if [[ $output_is_default == 0 ]]; then
  [[ -d $output_parent && ! -L $output_parent ]] || fail "output parent directory must exist and must not be a symlink: $output_parent"
fi
[[ $frozen == 1 || -d $project_directory ]] || fail "project directory does not exist: $project_directory"
[[ -x $node_executable ]] || fail "node is missing or not executable: $node_executable"
[[ ! -e $output_path && ! -L $output_path ]] || fail "refusing to overwrite an existing destination: $output_path"

command -v swift >/dev/null 2>&1 || fail "the swift driver is required (Xcode Command Line Tools)"
swift_executable=$(command -v swift)
[[ -x $plist_buddy ]] || fail "PlistBuddy is required: $plist_buddy"

if [[ $frozen == 0 ]]; then
  # Resolve the checked dsh CLI entry from the manifest, never from a guess.
  # Only the dsh profile entry is supported.
  cli_manifest="${project_directory}/apps/cli/package.json"
  [[ -f $cli_manifest ]] || fail "dsh CLI manifest not found: $cli_manifest"
  entry_relative=$("$node_executable" -e '
    const fs = require("fs");
    const path = require("path");
    const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const entry = manifest.bin && manifest.bin.dsh;
    if (typeof entry === "string") {
      const root = fs.realpathSync(process.argv[2]);
      const resolved = fs.realpathSync(path.resolve(path.dirname(process.argv[1]), entry));
      const relative = path.relative(root, resolved);
      if (path.isAbsolute(entry) || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) {
        throw new Error("bin.dsh escapes the project directory");
      }
    }
    process.stdout.write(typeof entry === "string" ? entry : "");
  ' "$cli_manifest" "$project_directory")
  [[ -n $entry_relative ]] || fail "apps/cli/package.json does not declare bin.dsh; cannot resolve the checked CLI entry"
  [[ $entry_relative != /* ]] || fail "bin.dsh must be a manifest-relative path, got: $entry_relative"
  dsh_entry="${project_directory}/apps/cli/${entry_relative}"
  [[ -f $dsh_entry && -r $dsh_entry ]] || fail "resolved dsh CLI entry is missing or unreadable: $dsh_entry"
fi

# The default output lives under the launcher's gitignored .build directory,
# which a fresh checkout does not have; create it only after every input is
# validated, so a rejected build leaves nothing behind.
if [[ $output_is_default == 1 ]]; then
  [[ ! -L $output_parent ]] || fail "default output parent must not be a symlink: $output_parent"
  mkdir -p -- "$output_parent" || fail "could not create the default output parent directory: $output_parent"
fi

# SwiftPM always resolves the package through this directory, so the build
# works from any working directory (the launcher directory, the repository
# root, or elsewhere). SwiftPM's manifest sandbox is never weakened: if the
# host cannot run it, the failure is reported and the outer caller reruns the
# build in a host context that permits sandbox-exec.
swift_build_arguments=(build --package-path "$script_directory")

print "building ${swiftpm_product} through SwiftPM (Package.swift declares the macOS 13 deployment target)..."
if ! swiftpm_output=$("$swift_executable" "${swift_build_arguments[@]}" --product "$swiftpm_product" 2>&1); then
  print -u2 -r -- "$swiftpm_output"
  if [[ $swiftpm_output == *sandbox_apply* || $swiftpm_output == *"sandbox-exec:"* ]]; then
    print -u2 "build.sh: this host blocked SwiftPM's manifest sandbox (sandbox-exec); rerun the build in a host context that permits it. No weakened fallback is attempted."
  fi
  fail "SwiftPM build of ${swiftpm_product} failed (output above)"
fi

if ! bin_path_output=$("$swift_executable" "${swift_build_arguments[@]}" --product "$swiftpm_product" --show-bin-path 2>&1); then
  print -u2 -r -- "$bin_path_output"
  fail "could not resolve the SwiftPM binary directory for ${swiftpm_product}"
fi
bin_directory=${bin_path_output##*$'\n'}
built_binary="${bin_directory}/${swiftpm_product}"
[[ -x $built_binary ]] || fail "SwiftPM did not produce the ${swiftpm_product} binary at: $built_binary"

# Stage the complete bundle in a fresh private directory on the output volume
# and publish it with a single atomic rename, so a failed build can never leave
# a partial destination. Cleanup touches only this staging directory.
stage_directory=$(mktemp -d "${output_path:h}/.deepseek-harness-launcher-build.XXXXXX")
trap 'rm -rf "$stage_directory"' EXIT

# Compile the build-only publication helper into the private staging directory
# with the Command Line Tools already required for the SwiftPM build.
publish_helper="${stage_directory}/publish-rename"
cc -o "$publish_helper" "${script_directory}/publish-rename.c" \
  || fail "could not compile the publication helper (cc from the Xcode Command Line Tools is required)"

app_stage="${stage_directory}/${bundle_directory_name}"
if [[ $frozen == 1 ]]; then app_stage="${stage_directory}/${frozen_bundle_directory_name}"; fi
mkdir -p "${app_stage}/Contents/MacOS" "${app_stage}/Contents/Resources"
cp "$built_binary" "${app_stage}/Contents/MacOS/${executable_name}"

cp "${script_directory}/Info.plist" "${app_stage}/Contents/Info.plist"
[[ $("$plist_buddy" -c "Print :CFBundleIdentifier" "${script_directory}/Info.plist") == "$stable_bundle_identifier" ]] \
  || fail "Info.plist must carry the stable identifier ${stable_bundle_identifier}; the candidate suffix is applied at build time"
"$plist_buddy" \
  -c "Set :CFBundleIdentifier ${bundle_identifier}" \
  -c "Set :CFBundleName ${display_name}" \
  -c "Set :CFBundleDisplayName ${display_name}" \
  "${app_stage}/Contents/Info.plist"

if [[ $frozen == 1 ]]; then
  # The materializer copies the deployed runtime and the standalone Node into
  # Resources as independent bytes, seals the bundled loopback overlay,
  # re-signs every Mach-O payload file ad hoc, verifies the copied Node
  # executes, and writes the SHA-256 inventory the App validates before it
  # starts the bundled Node. Source revision and lockfile digest are recorded
  # verbatim as source identifiers; this is not an approved stable release.
  "$node_executable" "$freeze_tool" materialize \
    --runtime "$runtime_directory" \
    --node "$node_executable" \
    --resources "${app_stage}/Contents/Resources" \
    --dsh-home "$dsh_home" \
    --source-rev "$source_revision" \
    --lockfile-digest "$lockfile_digest" \
    || fail "freezing the runtime failed; the staged bundle was discarded"
else
  # Non-secret configuration consumed by the App at startup. Node serializes
  # the JSON, so no path value can inject structure into the file. Paths only;
  # the launch token is minted by the backend at runtime and never recorded.
  "$node_executable" -e '
    const fs = require("fs");
    const [projectDirectory, nodeExecutable, dshEntry, destination] = process.argv.slice(1);
    fs.writeFileSync(
      destination,
      JSON.stringify({ projectDirectory, nodeExecutable, dshEntry }, null, 2) + "\n",
      { mode: 0o644 });
  ' "$project_directory" "$node_executable" "$dsh_entry" "${app_stage}/Contents/Resources/launcher-config.json"
fi

codesign --force --sign - \
  --requirements "=designated => identifier \"${bundle_identifier}\"" \
  "$app_stage"
codesign --verify --deep --strict "$app_stage"

# Publish with an atomic no-replace rename. The helper either moves the staged
# bundle to the destination or changes nothing, so a concurrent writer that
# creates the destination first makes publication fail loudly while the winner
# and its contents stay untouched.
"$publish_helper" "$app_stage" "$output_path" \
  || fail "atomic publication failed at ${output_path}; the existing destination is preserved and nothing was published"
[[ -d $output_path ]] || fail "publishing the bundle failed: $output_path"
[[ $("$plist_buddy" -c "Print :CFBundleIdentifier" "${output_path}/Contents/Info.plist") == "$bundle_identifier" ]] \
  || fail "the published bundle does not carry the expected identifier; refusing to claim success"

if [[ $frozen == 1 ]]; then
  print "built and signed: $output_path"
  print "  identifier: $frozen_bundle_identifier"
  print "  runtime:    $runtime_directory"
  print "  node:       $node_executable"
  print "  dsh home:   $dsh_home"
  print "  source rev: $source_revision"
  print "  lockfile:   $lockfile_digest"
  print "frozen candidate: the bundle materializes its own runtime copy. Data separation is NOT process or network confinement: the backend runs with the user's normal privileges and reaches the network like any other process."
  exit 0
fi

print "built and signed: $output_path"
print "  identifier: $candidate_bundle_identifier"
print "  project:    $project_directory"
print "  node:       $node_executable"
print "  entry:      $dsh_entry"
print "source-linked candidate: it runs the configured checkout's built CLI; it is not a frozen runtime."
