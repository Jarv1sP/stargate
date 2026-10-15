#!/bin/sh
set -eu
export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
TRUSTED=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
commit= worktree= allow_dirty=0 level=fast only= keep=0
die() { printf '灰度：%s\n' "$*" >&2; exit 2; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --commit) commit=${2:?}; shift 2 ;;
    --worktree) worktree=${2:?}; shift 2 ;;
    --allow-dirty) allow_dirty=1; shift ;;
    --level) level=${2:?}; shift 2 ;;
    --only) only=${2:?}; shift 2 ;;
    --tier) [ "${2:?}" = cpu ] || die '本机只支持 cpu'; shift 2 ;;
    --keep) keep=1; shift ;;
    *) die "未知参数 $1" ;;
  esac
done
[ -z "$commit" ] || [ -z "$worktree" ] || die '--commit 与 --worktree 不能同时使用'
case "$level" in fast|full) ;; *) die 'level 必须为 fast/full' ;; esac
for name in PORTAL_DOMAIN HEADSCALE_DOMAIN PORTAL_ENV_FILE PORTAL_COMPOSE_FILE; do
  eval "value=\${$name:-}"; [ -z "$value" ] || die "发现 $name，停止"
done
[ ! -e /opt/gpuq-console ] || die '发现生产安装目录，停止'
case "${DOCKER_HOST:-unix:///var/run/docker.sock}" in unix:///*) ;; *) die 'Docker 必须使用本地 socket' ;; esac
[ "$(docker context show)" = default ] || die 'Docker 必须使用本地 default context'
docker info >/dev/null
[ -z "$(docker ps -aq --filter label=com.docker.compose.project=stargate-gray)" ] || die '已有灰度容器，停止'
stamp=$(date -u +%Y%m%dT%H%M%SZ)-$$
run=$TRUSTED/out/gray/$stamp
mkdir -p "$run/src"
set -- "$TRUSTED" "$run/src"
if [ -n "$worktree" ]; then set -- "$@" --worktree "$worktree"; fi
if [ -n "$commit" ]; then set -- "$@" --commit "$commit"; fi
if [ "$allow_dirty" = 1 ]; then set -- "$@" --allow-dirty; fi
python3 "$TRUSTED/scripts/gray-local/export-source.py" "$@" > "$run/source.json"
commit=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["commit"])' "$run/source.json")
printf '候选 %s；报告目录 %s\n' "$commit" "$run"
losetup -a > "$run/loops-before.txt"
python3 "$TRUSTED/scripts/gray-local/prepare.py" "$run" "$TRUSTED"
port=${GRAY_PORT:-$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')}
export GRAY_RUN=$run GRAY_PORT=$port
export GRAY_PORTAL_IMAGE=stargate-gray/portal:$stamp GRAY_BRIDGE_IMAGE=stargate-gray/bridge:$stamp GRAY_NODE_IMAGE=stargate-gray/node:$stamp
compose() { docker compose -p stargate-gray -f "$TRUSTED/deploy/gray-local/compose.yml" "$@"; }
cleanup() {
  result=$?
  trap - EXIT INT TERM
  if [ "$keep" = 1 ] && [ "$result" = 0 ]; then
    printf '保留栈：%s/stack.json；请使用 teardown.sh 拆除\n' "$run"
  else
    compose down -v --remove-orphans > "$run/teardown.log" 2>&1 || result=1
    losetup -a > "$run/loops-after.txt"
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
(
  cd "$run/src"
  git init -q
  git add -A
  git -c user.name=gray -c user.email=gray@example.invalid commit -qm candidate
  npm ci --ignore-scripts
  python3 -I -B scripts/build-node-release.py --output "$run/node-release" --machine gray-node-1 > "$run/node-release.json"
)
# 客户端需要候选自己的四平台 Go helper；只在临时容器编译。
mkdir -p "$TRUSTED/out/gray-cache/go"
docker run --rm --label com.docker.compose.project=stargate-gray --memory=256m --memory-swap=256m --network=none \
  --user "$(id -u):$(id -g)" -e GOCACHE=/cache -e GOMAXPROCS=1 -e GOMEMLIMIT=160MiB \
  -e GOTOOLCHAIN=local -e GOPROXY=off -e GOSUMDB=off -e CGO_ENABLED=0 \
  -v "$run/src:/src" -v "$TRUSTED/out/gray-cache/go:/cache" -v "$(command -v node):/usr/local/bin/node:ro" -w /src golang:1.24-bookworm \
  node scripts/build-campus-native.mjs
cp "$TRUSTED/deploy/gray-local/base.Dockerfile" "$run/base-context/Dockerfile"
docker build -t "stargate-gray/base:$stamp" "$run/base-context" > "$run/build-base.log" 2>&1
docker save -o "$run/node-context/python.tar" "stargate-gray/base:$stamp"
cp -a "$run/node-release/gray-node-1" "$run/node-context/release"
cp "$TRUSTED"/deploy/gray-local/node-setup.sh "$TRUSTED"/deploy/gray-local/fake-nvidia-smi.py "$TRUSTED"/deploy/gray-local/gray-node-setup.service "$run/node-context/"
docker build -f "$run/src/deploy/Dockerfile" -t "$GRAY_PORTAL_IMAGE" "$run/src" > "$run/build-portal.log" 2>&1
docker build -f "$TRUSTED/deploy/gray-local/bridge.Dockerfile" -t "$GRAY_BRIDGE_IMAGE" "$TRUSTED/deploy/gray-local" > "$run/build-bridge.log" 2>&1
docker build -f "$TRUSTED/deploy/gray-local/node.Dockerfile" -t "$GRAY_NODE_IMAGE" "$run/node-context" > "$run/build-node.log" 2>&1
compose config > "$run/compose.yml"
compose up -d > "$run/start.log" 2>&1
i=0
until compose exec -T gray-node-1 test -f /run/gray-node-ready 2>/dev/null; do
  i=$((i+1)); [ "$i" -lt 120 ] || die '节点安装超时'
  if compose exec -T gray-node-1 systemctl is-failed -q gray-node-setup 2>/dev/null; then
    compose exec -T gray-node-1 journalctl -u gray-node-setup --no-pager > "$run/node-setup.log"
    die "节点安装失败，见 $run/node-setup.log"
  fi
  sleep 5
done
compose restart gray-collector >/dev/null
i=0
until curl -fsS "http://127.0.0.1:$port/healthz" > "$run/health.json" 2>/dev/null; do
  i=$((i+1)); [ "$i" -lt 60 ] || die '门户未就绪'; sleep 2
done
node_python=$(compose exec -T gray-node-1 cat /run/gray-node-python)
python3 - "$run" "$TRUSTED" "$commit" "$port" "$node_python" <<'PY'
import json,os,sys
from pathlib import Path
run,trusted,commit,port,node_python=sys.argv[1:]
stack=dict(source=json.loads(Path(run,'source.json').read_text()),nodePython=node_python,version=1,project='stargate-gray',origin=f'http://127.0.0.1:{port}',tier='cpu',machines=['gray-node-1'],cardsPerNode=2,adminPasswordFile='admin-password',commit=commit,compose=['docker','compose','-p','stargate-gray','-f',run+'/compose.yml'],nodeRelease=json.loads(Path(run,'node-release.json').read_text()))
Path(run,'stack.json').write_text(json.dumps(stack,indent=2))
PY
node "$TRUSTED/scripts/gray-local/check-features.mjs" "$run/src" > "$run/features-check.json"
node "$TRUSTED/scripts/gray-local/inspect-stack.mjs" "$run/stack.json" > "$run/isolation-check.log"
if [ "$only" != none ]; then
  node "$TRUSTED/tests/gray/run.mjs" --stack "$run/stack.json" --level "$level" --report "$run" ${only:+--only "$only"}
fi
