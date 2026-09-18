#!/bin/zsh
# Build, sign, and verify the two independent recovery Apps through SwiftPM:
# an ordinary Recovery App and an Emergency Recovery App. Both are ordinary
# .app bundles with distinct bundle identifiers and independent copies of the
# executable and resources; neither embeds or links the main LauncherApp
# executable, and neither depends on a source checkout or a global Node at
# runtime. Each App carries a sealed build configuration naming exactly one
# managed installation root, which the App verifies against an explicit
# versioned last-good record at startup. This script never installs: the
# output paths must not exist, and no existing App is ever replaced.

set -euo pipefail

script_directory=${0:A:h}
launcher_directory=${script_directory:h}
stable_bundle_identifier="com.local.deepseek-harness-launcher"
recovery_bundle_identifier="${stable_bundle_identifier}.recovery"
emergency_bundle_identifier="${stable_bundle_identifier}.recovery.emergency"
recovery_display_name="DeepSeek Harness Recovery"
emergency_display_name="DeepSeek Harness Emergency Recovery"
recovery_directory_name="${recovery_display_name}.app"
emergency_directory_name="${emergency_display_name}.app"
executable_name="DeepSeek Harness Recovery"
swiftpm_product="RecoveryApp"
default_output_root="${launcher_directory}/.build"
plist_buddy="/usr/libexec/PlistBuddy"

installation_root=""
output_root="$default_output_root"
output_is_default=1

usage() {
  print -u2 "usage: build-recovery.sh --installation <absolute managed installation root> [--output-root <absolute existing parent directory>]"
  print -u2 "  Builds \"${recovery_directory_name}\" and \"${emergency_directory_name}\" with distinct bundle identifiers, independently copied executables and resources, and a sealed recovery-installation.json naming the installation root."
  print -u2 "  Refuses to overwrite any existing destination."
  exit 2
}

fail() {
  print -u2 "build-recovery.sh: $1"
  exit 1
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --installation)
      [[ $# -ge 2 ]] || usage
      installation_root=$2
      shift 2
      ;;
    --output-root)
      [[ $# -ge 2 ]] || usage
      output_root=$2
      output_is_default=0
      shift 2
      ;;
    *)
      usage
      ;;
  esac
done

[[ -n $installation_root ]] || usage
[[ $installation_root = /* ]] || fail "--installation must be an absolute path, got: $installation_root"
[[ -d $installation_root && ! -L $installation_root ]] || fail "installation root must be a real directory, not a symlink: $installation_root"
[[ $output_root = /* ]] || fail "--output-root must be an absolute path, got: $output_root"
if [[ $output_is_default == 1 ]]; then
  mkdir -p -- "$output_root" || fail "could not create the default output root: $output_root"
fi
[[ -d $output_root && ! -L $output_root ]] || fail "output root must be a real directory, not a symlink: $output_root"
for destination in "${output_root}/${recovery_directory_name}" "${output_root}/${emergency_directory_name}"; do
  [[ ! -e $destination && ! -L $destination ]] || fail "refusing to overwrite an existing destination: $destination"
done

command -v swift >/dev/null 2>&1 || fail "the swift driver is required (Xcode Command Line Tools)"
swift_executable=$(command -v swift)
command -v node >/dev/null 2>&1 || fail "node is required to write the sealed configuration"
[[ -x $plist_buddy ]] || fail "PlistBuddy is required: $plist_buddy"

# SwiftPM always resolves the package through the launcher directory. SwiftPM's
# manifest sandbox is never weakened here: if the host cannot run it, the
# failure is reported and the outer caller reruns the build in a host context
# that permits sandbox-exec.
print "building ${swiftpm_product} through SwiftPM (Package.swift declares the macOS 13 deployment target)..."
swift_build_arguments=(build --package-path "$launcher_directory")
if ! swiftpm_output=$("$swift_executable" "${swift_build_arguments[@]}" --product "$swiftpm_product" 2>&1); then
  print -u2 -r -- "$swiftpm_output"
  if [[ $swiftpm_output == *sandbox_apply* || $swiftpm_output == *"sandbox-exec:"* ]]; then
    print -u2 "build-recovery.sh: this host blocked SwiftPM's manifest sandbox (sandbox-exec); rerun the build in a host context that permits it. No weakened fallback is attempted."
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

stage_directory=$(mktemp -d "${output_root}/.deepseek-harness-recovery-build.XXXXXX")
trap 'rm -rf "$stage_directory"' EXIT

publish_helper="${stage_directory}/publish-rename"
cc -o "$publish_helper" "${launcher_directory}/publish-rename.c" \
  || fail "could not compile the publication helper (cc from the Xcode Command Line Tools is required)"

# Seal the managed installation into each App's resources. The App re-verifies
# this root against the explicit last-good record at every startup; sealing is
# a build-time selection, not a runtime scan.
sealed_configuration=$(mktemp "${stage_directory}/recovery-installation.XXXXXX")
node -e '
  const fs = require("fs");
  const [installationRoot, destination] = process.argv.slice(1);
  fs.writeFileSync(
    destination,
    JSON.stringify({ schema: "deepseek-harness.recovery.installation/1", installationRoot }, null, 2) + "\n",
    { mode: 0o644 });
' "$installation_root" "$sealed_configuration"

build_one() {
  local bundle_identifier=$1 display_name=$2 directory_name=$3
  local app_stage="${stage_directory}/${directory_name}"
  mkdir -p "${app_stage}/Contents/MacOS" "${app_stage}/Contents/Resources"
  # Independent copy: each bundle gets its own executable bytes.
  cp "$built_binary" "${app_stage}/Contents/MacOS/${executable_name}"

  cp "${launcher_directory}/Info.plist" "${app_stage}/Contents/Info.plist"
  [[ $("$plist_buddy" -c "Print :CFBundleIdentifier" "${launcher_directory}/Info.plist") == "$stable_bundle_identifier" ]] \
    || fail "Info.plist must carry the stable identifier ${stable_bundle_identifier}; the recovery suffix is applied at build time"
  "$plist_buddy" \
    -c "Set :CFBundleIdentifier ${bundle_identifier}" \
    -c "Set :CFBundleName ${display_name}" \
    -c "Set :CFBundleDisplayName ${display_name}" \
    -c "Set :CFBundleExecutable ${executable_name}" \
    "${app_stage}/Contents/Info.plist"
  cp "$sealed_configuration" "${app_stage}/Contents/Resources/recovery-installation.json"

  codesign --force --sign - \
    --requirements "=designated => identifier \"${bundle_identifier}\"" \
    "$app_stage"
  codesign --verify --deep --strict "$app_stage"

  "$publish_helper" "$app_stage" "${output_root}/${directory_name}" \
    || fail "atomic publication failed at ${output_root}/${directory_name}; the existing destination is preserved and nothing was published"
  [[ -d "${output_root}/${directory_name}" ]] || fail "publishing the bundle failed: ${output_root}/${directory_name}"
  [[ $("$plist_buddy" -c "Print :CFBundleIdentifier" "${output_root}/${directory_name}/Contents/Info.plist") == "$bundle_identifier" ]] \
    || fail "the published bundle does not carry the expected identifier; refusing to claim success"
}

build_one "$recovery_bundle_identifier" "$recovery_display_name" "$recovery_directory_name"
build_one "$emergency_bundle_identifier" "$emergency_display_name" "$emergency_directory_name"

print "built and signed: ${output_root}/${recovery_directory_name}"
print "  identifier: $recovery_bundle_identifier"
print "built and signed: ${output_root}/${emergency_directory_name}"
print "  identifier: $emergency_bundle_identifier"
print "  installation: $installation_root"
print "recovery Apps are diagnostic plus opt-in last-good launch only: a recovery launch is not an upgrade and not a data rollback. Metadata digests detect accidental mismatch, not a same-user malicious rewrite."
