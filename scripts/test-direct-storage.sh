#!/usr/bin/env bash
# Workspace workflows and historical read/cancel recovery; independent groups.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
node_bin="${NODE:-node}"
python_bin="${PYTHON:-python3}"
log_dir="${TEST_LOG_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/direct-storage-tests.XXXXXX")}"
mkdir -p "$log_dir"
if ! "$node_bin" scripts/build-client.mjs >"$log_dir/build.log" 2>&1; then
  printf 'client build failed: %s/build.log\n' "$log_dir"
  exit 1
fi

python_tests() {
  local file result=0
  for file in local-data data-uploads data-copy project-copy live-workspace workspace-rootfs workspace-shell personal-oci terminal-sessions shared-memory-pool project-upload-recovery project-security legacy-preparation-cancel common-p0-runner; do
    "$python_bin" "tests/$file.test.py" || result=1
  done
  return "$result"
}
node_tests() {
  "$node_bin" --test tests/personal-upload-client.test.js \
    tests/data-workspace-client.test.js tests/data-copy-cli.test.js \
    tests/direct-storage-flow.test.js tests/job-terminal-live.test.js tests/admin-quota-dispatch.test.js \
    tests/submission-contract.test.js tests/shared-memory-submission.test.js tests/bridge-availability.test.js \
    tests/execution-bridge.test.js tests/task-submit.test.js tests/auto-placement.test.js \
    tests/api-cli.test.js tests/auto-allocation-receipt.test.js \
    tests/priority-api.test.js tests/scheduling-policy.test.js tests/gpu-placement.test.js tests/elastic-allocation.test.js \
    tests/submission-recovery.test.js tests/manual-machine.test.js \
    tests/cancel-persistence.test.js tests/execution-fair-reconcile.test.js tests/execution.test.js \
    tests/dataset-preparation.test.js tests/training-preparation.test.js \
    tests/native-task-metadata.test.js tests/task-metadata.test.js tests/task-display-api.test.js \
    tests/job-observation.test.js tests/job-completion.test.js \
    tests/client-project-read-retry.test.js tests/project-upload-recovery.test.js \
    tests/guide-workflow.test.js tests/user-guide-content.test.js \
    tests/cli-help-workflow.test.js tests/client-docker-context.test.js tests/portal-image.test.js tests/demo-data-roots.test.js \
    tests/client-file-download.test.js tests/client-directory-download.test.js \
    tests/project-replication.test.js
}
browser_tests() {
  local file result=0
  for file in direct-storage-ui-smoke live-workspace-ui-smoke guide-ui-smoke auto-placement-ui-smoke; do
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
