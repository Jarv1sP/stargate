#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
npm run build:client
node --test tests/workshop-*.test.js tests/navigation.test.js tests/community.test.js tests/login-sessions.test.js
node tests/workshop-ui-smoke.mjs
node tests/workshop-ui-races-smoke.mjs
node tests/workshop-runtime-browser.mjs
