#!/usr/bin/env bash
# New direct-storage contract only; each group runs independently in parallel.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
node_bin="${NODE:-node}"
python_bin="${PYTHON:-python3}"
log_dir="${TEST_LOG_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/direct-storage-tests.XXXXXX")}"
mkdir -p "$log_dir"

python_tests() {
  local file result=0
  for file in local-data data-uploads data-copy live-workspace workspace-rootfs workspace-shell personal-oci terminal-sessions; do
    "$python_bin" "tests/$file.test.py" || result=1
  done
  return "$result"
}
node_tests() {
  "$node_bin" --test tests/personal-upload-client.test.js \
    tests/data-workspace-client.test.js tests/data-copy-cli.test.js \
    tests/direct-storage-flow.test.js tests/admin-quota-dispatch.test.js
}
browser_tests() {
  local file result=0
  for file in direct-storage-ui-smoke live-workspace-ui-smoke; do
    "$node_bin" "tests/$file.mjs" || result=1
  done
  return "$result"
}

declare -a groups=(python node browser) pids=()
for group in "${groups[@]}"; do
  "${group}_tests" >"$log_dir/$group.log" 2>&1 &
  pids+=("$!")
done
result=0
for index in "${!groups[@]}"; do
  code=0
  wait "${pids[$index]}" || code=$?
  printf '%s\n' "$code" >"$log_dir/${groups[$index]}.exit"
  printf '%s: exit=%s log=%s\n' "${groups[$index]}" "$code" "$log_dir/${groups[$index]}.log"
  if (( code != 0 )); then result=1; fi
done
exit "$result"
