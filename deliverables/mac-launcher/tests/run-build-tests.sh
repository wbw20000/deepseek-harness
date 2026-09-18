#!/bin/zsh
# Regression tests for build.sh. Every test works inside a fresh private
# fixture directory that this script owns and removes on exit. No test binds a
# port, writes credentials, launches the installed App, or quits it: build.sh
# only compiles, signs, and publishes a candidate bundle. Publication is
# exercised through the real publish-rename helper, never through a shim that
# restates its own assumptions.

set -u

tests_dir=${0:A:h}
launcher_dir=${tests_dir:h}
build_script="${launcher_dir}/build.sh"
repo_root=${launcher_dir:h:h}
plist_buddy="/usr/libexec/PlistBuddy"
candidate_identifier="com.local.deepseek-harness-launcher.candidate"
candidate_display_name="DeepSeek Harness (Candidate)"
executable_name="DeepSeek Harness"

node_executable=${NODE_EXECUTABLE:-$(command -v node 2>/dev/null)}
fixture_root=""

passed=0
failed=0

cleanup() {
  if [[ -n $fixture_root ]]; then
    rm -rf "$fixture_root"
  fi
}
trap cleanup EXIT

begin() {
  print "— $1"
}

pass_test() {
  passed=$((passed + 1))
}

fail_test() {
  print -u2 "FAIL: $1"
  failed=$((failed + 1))
}

# Runs build.sh with the given arguments and captures combined output in
# $build_output and the exit status in $build_rc. $extra_path, when set, is
# prepended to PATH so hermetic shims can stand in for build tools.
extra_path=""
run_build_in() {
  local work_dir=$1
  shift
  build_output=$(cd "$work_dir" && PATH="${extra_path:+$extra_path:}$PATH" zsh "$build_script" "$@" 2>&1)
  build_rc=$?
}

run_build() {
  run_build_in "$PWD" "$@"
}

assert() {
  local description=$1
  shift
  if "$@"; then
    return 0
  fi
  print -u2 "  assertion failed: $description"
  print -u2 "  build.sh said: ${build_output:-<no output>}"
  return 1
}

assert_no_match() {
  local description=$1
  local pattern=$2
  if [[ $build_output != *$pattern* ]]; then
    return 0
  fi
  print -u2 "  assertion failed: $description"
  print -u2 "  build.sh said: ${build_output:-<no output>}"
  return 1
}

expect_rejection() {
  local description=$1
  shift
  mkdir -p "${reject_destination:h}"
  run_build "$@"
  if assert "$description" test "$build_rc" -ne 0 \
    && assert "no destination was created" test ! -e "$reject_destination"; then
    pass_test
  else
    fail_test "$description"
  fi
}

[[ -n $node_executable ]] || { print -u2 "node is required (set NODE_EXECUTABLE)"; exit 1 }
[[ -f $build_script ]] || { print -u2 "build.sh not found: $build_script"; exit 1 }
[[ -d $repo_root/apps/cli ]] || { print -u2 "dsh checkout not found: $repo_root"; exit 1 }

fixture_root=$(mktemp -d "${TMPDIR:-/tmp}/dsh-launcher-build-tests.XXXXXX")

# The CLI entry the manifest currently declares; build.sh must resolve the same one.
expected_entry="${repo_root}/apps/cli/$("$node_executable" -e '
  const fs = require("fs");
  process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).bin.dsh);
' "$repo_root/apps/cli/package.json")"

# --- argument and input rejection ---------------------------------------------

reject_destination="$fixture_root/exists/App.app"
begin "rejects an existing destination and preserves the sentinel"
mkdir -p "$reject_destination"
print -r -- "sentinel" > "$reject_destination/sentinel"
run_build --project-dir "$repo_root" --node "$node_executable" --output "$reject_destination"
if assert "existing destination is refused" test "$build_rc" -ne 0 \
  && assert "sentinel file survives" test -f "$reject_destination/sentinel" \
  && assert "sentinel content survives" grep -q "sentinel" "$reject_destination/sentinel"; then
  pass_test
else
  fail_test "rejects an existing destination and preserves the sentinel"
fi

reject_destination="$fixture_root/link/App.app"
begin "rejects a symlink destination and preserves the link"
mkdir -p "${reject_destination:h}"
ln -s "$fixture_root/nowhere" "$reject_destination"
run_build --project-dir "$repo_root" --node "$node_executable" --output "$reject_destination"
if assert "symlink destination is refused" test "$build_rc" -ne 0 \
  && assert "symlink survives" test -L "$reject_destination"; then
  pass_test
else
  fail_test "rejects a symlink destination and preserves the link"
fi

begin "rejects relative --project-dir"
reject_destination="$fixture_root/relative/one.app"
expect_rejection "relative --project-dir is refused" --project-dir "Sources" --node "$node_executable" --output "$reject_destination"

begin "rejects relative --node"
reject_destination="$fixture_root/relative/two.app"
expect_rejection "relative --node is refused" --project-dir "$repo_root" --node "node" --output "$reject_destination"

begin "rejects relative --output"
reject_destination="$fixture_root/relative/three.app"
mkdir -p "$fixture_root/relative-cwd"
run_build_in "$fixture_root/relative-cwd" --project-dir "$repo_root" --node "$node_executable" --output "relative-out.app"
if assert "relative --output is refused" test "$build_rc" -ne 0 \
  && assert "the private working directory stays empty" test -z "$(ls -A "$fixture_root/relative-cwd")"; then
  pass_test
else
  fail_test "relative --output is refused"
fi

begin "rejects a nonexistent project directory"
reject_destination="$fixture_root/missing/App.app"
expect_rejection "nonexistent --project-dir is refused" --project-dir "$fixture_root/missing-checkout" --node "$node_executable" --output "$reject_destination"

begin "rejects a nonexistent node executable"
reject_destination="$fixture_root/missing/App2.app"
expect_rejection "nonexistent --node is refused" --project-dir "$repo_root" --node "$fixture_root/missing-node" --output "$reject_destination"

begin "rejects a project without the dsh CLI manifest"
reject_destination="$fixture_root/nomanifest/App.app"
expect_rejection "missing apps/cli/package.json is refused" --project-dir "$fixture_root/nomanifest" --node "$node_executable" --output "$reject_destination"

begin "rejects a manifest without bin.dsh"
reject_destination="$fixture_root/nobin/App.app"
mkdir -p "$fixture_root/nobin/apps/cli"
print -r -- '{ "name": "fixture" }' > "$fixture_root/nobin/apps/cli/package.json"
expect_rejection "manifest without bin.dsh is refused" --project-dir "$fixture_root/nobin" --node "$node_executable" --output "$reject_destination"

begin "rejects a CLI manifest entry outside the source checkout"
reject_destination="$fixture_root/escaping/App.app"
mkdir -p "$fixture_root/escaping/apps/cli"
print -r -- 'throw new Error("outside entry must not run")' > "$fixture_root/outside.js"
print -r -- '{ "bin": { "dsh": "../../../outside.js" } }' > "$fixture_root/escaping/apps/cli/package.json"
expect_rejection "escaping bin.dsh is refused" --project-dir "$fixture_root/escaping" --node "$node_executable" --output "$reject_destination"

# --- build failure ------------------------------------------------------------

begin "a failed SwiftPM build leaves no destination and no staging residue"
shim_dir="$fixture_root/shim-build-failure"
mkdir -p "$shim_dir"
print -r -- '#!/bin/sh
echo "simulated SwiftPM build failure" >&2
exit 1
' > "$shim_dir/swift"
chmod +x "$shim_dir/swift"
build_failure_dir="$fixture_root/build-failure"
reject_destination="$build_failure_dir/App.app"
mkdir -p "$build_failure_dir"
extra_path="$shim_dir" run_build --project-dir "$repo_root" --node "$node_executable" --output "$reject_destination"
extra_path=""
if assert "failed build is reported" test "$build_rc" -ne 0 \
  && assert "no destination exists after a failed build" test ! -e "$reject_destination" \
  && assert "no staging residue remains" test -z "$(ls -A "$build_failure_dir")"; then
  pass_test
else
  fail_test "a failed SwiftPM build leaves no destination and no staging residue"
fi

# --- atomic publication helper ------------------------------------------------
# These tests compile the same publish-rename.c that build.sh compiles into its
# staging directory and exercise the real publication operation directly: an
# existing file, directory, or symlink must survive with its sentinel content,
# a pre-existing directory must not gain extra children, and competing
# publishers must produce exactly one winner.

helper_dir="$fixture_root/helper"
mkdir -p "$helper_dir"
publish_helper="$helper_dir/publish-rename"
if cc -o "$publish_helper" "${launcher_dir}/publish-rename.c"; then
  have_helper=1
else
  have_helper=0
  fail_test "cc could not compile publish-rename.c"
fi

if [[ $have_helper == 1 ]]; then
  pub_root="$fixture_root/publish"
  publish() {
    "$publish_helper" "$1" "$2" 2>/dev/null
  }

  begin "the publication helper publishes a fresh destination and removes the staged bundle"
  staged="$pub_root/staged-ok"
  mkdir -p "$staged/Contents/MacOS" "$pub_root/out"
  print -r -- "fresh" > "$staged/Contents/MacOS/$executable_name"
  if publish "$staged" "$pub_root/out/Fresh.app" \
    && test -f "$pub_root/out/Fresh.app/Contents/MacOS/$executable_name" \
    && test ! -e "$staged"; then
    pass_test
  else
    fail_test "the publication helper publishes a fresh destination and removes the staged bundle"
  fi

  begin "the publication helper refuses an existing file and preserves its sentinel"
  staged="$pub_root/staged-file"
  mkdir -p "$staged/Contents"
  print -r -- "staged" > "$staged/Contents/marker"
  target="$pub_root/out/Existing.file"
  print -r -- "sentinel" > "$target"
  if ! publish "$staged" "$target" \
    && test "$(cat "$target")" = "sentinel" \
    && test -f "$staged/Contents/marker"; then
    pass_test
  else
    fail_test "the publication helper refuses an existing file and preserves its sentinel"
  fi

  begin "the publication helper refuses an existing directory, preserves its sentinel, and adds no children"
  staged="$pub_root/staged-dir"
  mkdir -p "$staged/Contents"
  print -r -- "staged" > "$staged/Contents/marker"
  target="$pub_root/out/Existing.dir"
  mkdir -p "$target"
  print -r -- "sentinel" > "$target/keep"
  if ! publish "$staged" "$target" \
    && test "$(cat "$target/keep")" = "sentinel" \
    && test "$(ls -A "$target")" = "keep" \
    && test -f "$staged/Contents/marker"; then
    pass_test
  else
    fail_test "the publication helper refuses an existing directory, preserves its sentinel, and adds no children"
  fi

  begin "the publication helper refuses an existing symlink and preserves the link"
  staged="$pub_root/staged-link"
  mkdir -p "$staged/Contents"
  print -r -- "staged" > "$staged/Contents/marker"
  target="$pub_root/out/Existing.link"
  ln -s "$pub_root/out/nowhere" "$target"
  if ! publish "$staged" "$target" \
    && test -L "$target" \
    && test "$(readlink "$target")" = "$pub_root/out/nowhere" \
    && test ! -e "$pub_root/out/nowhere" \
    && test -f "$staged/Contents/marker"; then
    pass_test
  else
    fail_test "the publication helper refuses an existing symlink and preserves the link"
  fi

  begin "competing publishers publish exactly one winner and leave the loser's bundle staged"
  staged_a="$pub_root/staged-race-a"
  staged_b="$pub_root/staged-race-b"
  mkdir -p "$staged_a/Contents" "$staged_b/Contents"
  print -r -- "first" > "$staged_a/Contents/marker"
  print -r -- "second" > "$staged_b/Contents/marker"
  race_target="$pub_root/out/Race.app"
  "$publish_helper" "$staged_a" "$race_target" 2>/dev/null & helper_pid_a=$!
  "$publish_helper" "$staged_b" "$race_target" 2>/dev/null & helper_pid_b=$!
  wait "$helper_pid_a"; race_rc_a=$?
  wait "$helper_pid_b"; race_rc_b=$?
  race_successes=0
  [[ $race_rc_a -eq 0 ]] && race_successes=$((race_successes + 1))
  [[ $race_rc_b -eq 0 ]] && race_successes=$((race_successes + 1))
  if [[ $race_successes -eq 1 ]] \
    && test -f "$race_target/Contents/marker" \
    && { { test "$(cat "$race_target/Contents/marker")" = "first" && test ! -e "$staged_a" && test -f "$staged_b/Contents/marker"; } \
      || { test "$(cat "$race_target/Contents/marker")" = "second" && test ! -e "$staged_b" && test -f "$staged_a/Contents/marker"; } }; then
    pass_test
  else
    fail_test "competing publishers publish exactly one winner and leave the loser's bundle staged"
  fi
fi

# --- hermetic publication through build.sh ------------------------------------
# Shims stand in for swift and codesign so the tests exercise build.sh's
# packaging, configuration, and publication logic alone and never depend on the
# runtime sources compiling. The publication rename itself stays real.

shim_dir="$fixture_root/shim-hermetic"
fake_bin_dir="$fixture_root/fake-bin"
mkdir -p "$shim_dir" "$fake_bin_dir"
print -r -- '#!/bin/sh
# Test shim: answers --show-bin-path and otherwise fabricates a product binary,
# so no real SwiftPM build runs in this test.
for arg in "$@"; do
  if [ "$arg" = "--show-bin-path" ]; then
    echo "$FAKE_BIN_DIR"
    exit 0
  fi
done
mkdir -p "$FAKE_BIN_DIR"
printf "#!/bin/sh\nexit 0\n" > "$FAKE_BIN_DIR/LauncherApp"
chmod +x "$FAKE_BIN_DIR/LauncherApp"
exit 0
' > "$shim_dir/swift"
print -r -- '#!/bin/sh
exit 0
' > "$shim_dir/codesign"
chmod +x "$shim_dir/swift" "$shim_dir/codesign"
export FAKE_BIN_DIR="$fake_bin_dir"

begin "a hermetic build from the repository root publishes the candidate and leaves no staging residue"
hermetic_dir="$fixture_root/hermetic"
hermetic_destination="$hermetic_dir/${candidate_display_name}.app"
mkdir -p "$hermetic_dir"
extra_path="$shim_dir" run_build_in "$repo_root" --project-dir "$repo_root" --node "$node_executable" --output "$hermetic_destination"
extra_path=""
if assert "the hermetic build succeeds from the repository root" test "$build_rc" -eq 0 \
  && assert "the candidate identifier is published" \
    test "$("$plist_buddy" -c "Print :CFBundleIdentifier" "$hermetic_destination/Contents/Info.plist")" = "$candidate_identifier" \
  && assert "the helper is not shipped inside the bundle" test ! -e "$hermetic_destination/Contents/MacOS/publish-rename" \
  && assert "no staging residue remains" test "$(ls -A "$hermetic_dir")" = "${candidate_display_name}.app"; then
  pass_test
else
  fail_test "a hermetic build from the repository root publishes the candidate and leaves no staging residue"
fi

begin "a build from an unrelated working directory records quoting-heavy paths verbatim"
tricky_project="$fixture_root/tricky dir's \"quoted\" back\\slash"$'\t'"tab"
mkdir -p "$tricky_project/apps/cli/lib"
print -r -- '{ "name": "fixture", "bin": { "dsh": "lib/bin.js" } }' > "$tricky_project/apps/cli/package.json"
print -r -- '# fixture entry' > "$tricky_project/apps/cli/lib/bin.js"
tricky_output_dir="$fixture_root/out dir"
mkdir -p "$tricky_output_dir" "$fixture_root/unrelated-cwd"
tricky_destination="$tricky_output_dir/${candidate_display_name}.app"
extra_path="$shim_dir" run_build_in "$fixture_root/unrelated-cwd" \
  --project-dir "$tricky_project" --node "$node_executable" --output "$tricky_destination"
extra_path=""
tricky_config_ok=0
if [[ $build_rc -eq 0 ]]; then
  "$node_executable" -e '
    const fs = require("fs");
    const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const expected = {
      projectDirectory: process.argv[2],
      nodeExecutable: process.argv[3],
      dshEntry: process.argv[2] + "/apps/cli/lib/bin.js",
    };
    process.exit(JSON.stringify(config) === JSON.stringify(expected) ? 0 : 1);
  ' "$tricky_destination/Contents/Resources/launcher-config.json" \
    "$tricky_project" "$node_executable" \
    && tricky_config_ok=1
fi
if assert "the quoting-heavy build succeeds" test "$build_rc" -eq 0 \
  && assert "the config records the quoting-heavy paths verbatim" test "$tricky_config_ok" -eq 1; then
  pass_test
else
  fail_test "a build from an unrelated working directory records quoting-heavy paths verbatim"
  print -u2 "  build.sh said: ${build_output:-<no output>}"
fi

begin "the default --output creates its .build parent on a fresh tree and publishes there"
# A fresh checkout has no .build directory; build.sh must create it when the
# default output is selected. The launcher directory is copied without .build
# so the real checkout is never touched.
default_launcher="$fixture_root/default-launcher"
mkdir -p "$default_launcher"
cp "$build_script" "$default_launcher/build.sh"
cp "${launcher_dir}/publish-rename.c" "$default_launcher/publish-rename.c"
cp "${launcher_dir}/Info.plist" "$default_launcher/Info.plist"
mkdir -p "$fixture_root/default-cwd"
default_build_script="$build_script"
build_script="$default_launcher/build.sh"
extra_path="$shim_dir" run_build_in "$fixture_root/default-cwd" \
  --project-dir "$repo_root" --node "$node_executable"
build_script="$default_build_script"
extra_path=""
if assert "the default-output build succeeds" test "$build_rc" -eq 0 \
  && assert "the candidate is published under the created .build parent" \
    test -f "$default_launcher/.build/${candidate_display_name}.app/Contents/Info.plist" \
  && assert "no staging residue remains" test "$(ls -A "$default_launcher/.build")" = "${candidate_display_name}.app"; then
  pass_test
else
  fail_test "the default --output creates its .build parent on a fresh tree and publishes there"
  print -u2 "  build.sh said: ${build_output:-<no output>}"
fi

unset FAKE_BIN_DIR

# --- valid candidate ----------------------------------------------------------

begin "builds, signs, and verifies a valid candidate with correct identity and config"
candidate_destination="$fixture_root/candidate/${candidate_display_name}.app"
mkdir -p "$fixture_root/candidate"
run_build_in "$repo_root" --project-dir "$repo_root" --node "$node_executable" --output "$candidate_destination"
candidate_ok=1
assert "valid candidate build succeeds" test "$build_rc" -eq 0 || candidate_ok=0
if [[ $candidate_ok == 1 ]]; then
  identifier=$("$plist_buddy" -c "Print :CFBundleIdentifier" "$candidate_destination/Contents/Info.plist")
  display_name=$("$plist_buddy" -c "Print :CFBundleDisplayName" "$candidate_destination/Contents/Info.plist")
  assert "bundle identifier is the candidate identifier" test "$identifier" = "$candidate_identifier" || candidate_ok=0
  assert "display name is the candidate display name" test "$display_name" = "$candidate_display_name" || candidate_ok=0
  assert "the executable is present" test -x "$candidate_destination/Contents/MacOS/$executable_name" || candidate_ok=0
  codesign --verify --deep --strict "$candidate_destination" \
    || { print -u2 "  assertion failed: codesign --verify --deep --strict"; candidate_ok=0 }
  codesign -d -r- "$candidate_destination" 2>&1 | grep -qF "identifier \"$candidate_identifier\"" \
    || { print -u2 "  assertion failed: designated requirement does not pin the candidate identifier"; candidate_ok=0 }
  xcrun vtool -show-build "$candidate_destination/Contents/MacOS/$executable_name" | grep -q "minos 13.0" \
    || { print -u2 "  assertion failed: binary does not target the macOS 13 platform"; candidate_ok=0 }
  "$node_executable" -e '
    const fs = require("fs");
    const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const expected = {
      projectDirectory: process.argv[2],
      nodeExecutable: process.argv[3],
      dshEntry: process.argv[4],
    };
    process.exit(JSON.stringify(config) === JSON.stringify(expected) ? 0 : 1);
  ' "$candidate_destination/Contents/Resources/launcher-config.json" \
    "$repo_root" "$node_executable" "$expected_entry" \
    || { print -u2 "  assertion failed: launcher-config.json does not record the build inputs"; candidate_ok=0 }
fi
if [[ $candidate_ok == 1 ]]; then
  pass_test
else
  fail_test "builds, signs, and verifies a valid candidate with correct identity and config"
  print -u2 "  build.sh said: ${build_output:-<no output>}"
fi

begin "a second build over the published candidate is refused and leaves it intact"
if [[ ! -f $candidate_destination/Contents/Info.plist ]]; then
  fail_test "a second build over the published candidate is refused and leaves it intact"
  print -u2 "  skipped: no candidate was published, so the refusal cannot be exercised"
else
before_hash=$(shasum "$candidate_destination/Contents/Info.plist" | awk '{print $1}')
run_build --project-dir "$repo_root" --node "$node_executable" --output "$candidate_destination"
after_hash=$(shasum "$candidate_destination/Contents/Info.plist" | awk '{print $1}')
if assert "rebuild over the destination is refused" test "$build_rc" -ne 0 \
  && assert "published candidate is unchanged" test "$before_hash" = "$after_hash"; then
  pass_test
else
  fail_test "a second build over the published candidate is refused and leaves it intact"
fi
fi

begin "a rejected relative --output leaks nothing into the private test directory"
if [[ -e "$fixture_root/relative-cwd/relative-out.app" || -L "$fixture_root/relative-cwd/relative-out.app" ]]; then
  fail_test "a rejected relative --output leaks nothing into the private test directory"
else
  pass_test
fi

# Recovery build script refusals run before any SwiftPM build, so they are
# exercised here without a host that permits SwiftPM's manifest sandbox.
# run_recovery_build mirrors run_build_in for the recovery script.
run_recovery_build() {
  build_output=$(cd "$recovery_fixture" && zsh "$recovery_script" "$@" 2>&1)
  build_rc=$?
}
recovery_script="${launcher_dir}/tools/build-recovery.sh"
recovery_fixture="${fixture_root}/recovery"
mkdir -p "$recovery_fixture/installation" "$recovery_fixture/output"
begin "build-recovery.sh refuses missing arguments"
run_recovery_build
if assert "missing --installation is a usage refusal" test "$build_rc" -eq 2; then
  pass_test
else
  fail_test "build-recovery.sh refuses missing arguments"
fi
begin "build-recovery.sh refuses a relative and a missing installation root"
run_recovery_build --installation "relative/path"
refused_relative=$build_rc
run_recovery_build --installation "$recovery_fixture/absent-root"
if assert "relative root is refused" test "$refused_relative" -ne 0 \
  && assert "missing root is refused" test "$build_rc" -ne 0; then
  pass_test
else
  fail_test "build-recovery.sh refuses a relative and a missing installation root"
fi
begin "build-recovery.sh refuses an existing destination and leaves it intact"
touch "$recovery_fixture/output/DeepSeek Harness Recovery.app"
run_recovery_build --installation "$recovery_fixture/installation" --output-root "$recovery_fixture/output"
refusal_output=$build_output
if assert "existing destination is refused" test "$build_rc" -ne 0 \
  && [[ $refusal_output == *"refusing to overwrite"* ]] \
  && assert "the destination is untouched" test -f "$recovery_fixture/output/DeepSeek Harness Recovery.app"; then
  pass_test
else
  fail_test "build-recovery.sh refuses an existing destination and leaves it intact"
fi
begin "a refused recovery build leaves no staging directory"
staging_residue=$(find "$recovery_fixture/output" -maxdepth 1 -name ".deepseek-harness-recovery-build.*" | wc -l | tr -d ' ')
if assert "no staging residue" test "$staging_residue" -eq 0; then
  pass_test
else
  fail_test "a refused recovery build leaves no staging directory"
fi

print
print "$passed passed, $failed failed"
[[ $failed -eq 0 ]]
