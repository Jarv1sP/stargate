#!/bin/sh
# GitHub runner 与本机使用同一个 Docker full 路径。
set -eu
TRUSTED=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
commit=HEAD
while [ "$#" -gt 0 ]; do
  case "$1" in --commit) commit=${2:?}; shift 2 ;; *) echo "未知参数 $1" >&2; exit 2 ;; esac
done
if [ -n "${DOCKER_CONTEXT:-}" ] || [ -z "${DOCKER_HOST:-}" ]; then
  DOCKER_HOST=$(docker context inspect --format '{{.Endpoints.docker.Host}}')
fi
case "$DOCKER_HOST" in unix:///*) ;; *) echo '灰测必须使用本地 Docker socket' >&2; exit 2 ;; esac
export DOCKER_HOST
unset DOCKER_CONTEXT
docker info >/dev/null
[ -z "$(docker ps -aq --filter label=com.docker.compose.project=stargate-gray)" ] || { echo '已有灰度容器，停止' >&2; exit 2; }
stamp=$(date -u +%Y%m%dT%H%M%SZ)-$$
run=$TRUSTED/out/gray/$stamp
mkdir -p "$run/src"
python3 "$TRUSTED/scripts/gray-local/export-source.py" "$TRUSTED" "$run/src" --commit "$commit" > "$run/source.json"
commit=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["commit"])' "$run/source.json")
export STARGATE_RELEASE_REVISION=$commit
port=${GRAY_PORT:-$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')}
export GRAY_RUN=$run GRAY_PORT=$port
export GRAY_PORTAL_IMAGE=stargate-gray/portal:$stamp GRAY_BRIDGE_IMAGE=stargate-gray/bridge:$stamp GRAY_NODE_IMAGE=stargate-gray/node:$stamp GRAY_REGISTRY_IMAGE=stargate-gray/registry:$stamp
compose() { docker compose -p stargate-gray -f "$TRUSTED/deploy/gray-local/compose.yml" "$@"; }
build_image() { DOCKER_BUILDKIT=0 docker build --force-rm --network=host "$@"; }
extract=
cleanup() {
  result=$?
  trap - EXIT INT TERM
  [ -z "$extract" ] || docker rm -f "$extract" >/dev/null 2>&1 || :
  compose logs --no-color > "$run/compose.log" 2>&1 || :
  compose exec -T gray-node-1 journalctl -b --no-pager > "$run/node-journal.log" 2>&1 || :
  if [ "$result" -ne 0 ]; then
    compose exec -T gray-node-1 python3 - > "$run/gpuq-task-logs.log" 2>&1 <<'PY' || :
from pathlib import Path
import shutil,sys
root = Path('/data1/stargate/scheduler/logs')
for path in sorted((p for p in root.rglob('*') if p.is_file()), key=lambda p: p.stat().st_mtime, reverse=True)[:20]:
    sys.stdout.buffer.write(('\n===== '+str(path.relative_to(root))+' =====\n').encode())
    with path.open('rb') as source:
        shutil.copyfileobj(source, sys.stdout.buffer)
PY
  fi
  compose down -v --remove-orphans > "$run/teardown.log" 2>&1 || result=1
  for role in base portal bridge node registry; do docker image rm "stargate-gray/$role:$stamp" >/dev/null 2>&1 || :; done
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
printf '候选 %s；报告目录 %s\n' "$commit" "$run"
python3 "$TRUSTED/scripts/gray-local/prepare.py" "$run" "$TRUSTED" --build
python3 "$TRUSTED/scripts/gray-local/prepare.py" "$run" "$TRUSTED" --runtime
(
  cd "$run/src"
  git init -q
  git add -A
  git -c user.name=gray -c user.email=gray@example.invalid commit -qm candidate
  python3 -I -B scripts/build-node-release.py --output "$run/node-release" --machine gray-node-1 > "$run/node-release.json"
  node scripts/build-campus-native.mjs
)
cp "$TRUSTED/deploy/gray-local/base.Dockerfile" "$run/base-context/Dockerfile"
build_image -t "stargate-gray/base:$stamp" "$run/base-context" > "$run/build-base.log" 2>&1
docker save -o "$run/node-context/python.tar" "stargate-gray/base:$stamp"
cp -a "$run/node-release/gray-node-1" "$run/node-context/release"
cp "$run/src/deploy/node/install.py" "$run/node-context/node-install.py"
cp "$TRUSTED"/deploy/gray-local/node-setup.sh "$TRUSTED"/deploy/gray-local/fake-nvidia-smi.py "$TRUSTED"/deploy/gray-local/gray-node-setup.service "$run/node-context/"
cp "$run/machines.js" "$run/src/dist/machines.js"
build_image --build-arg STARGATE_RELEASE_REVISION="$commit" -f "$run/src/deploy/Dockerfile" -t "$GRAY_PORTAL_IMAGE" "$run/src" > "$run/build-portal.log" 2>&1
build_image -f "$TRUSTED/deploy/gray-local/bridge.Dockerfile" -t "$GRAY_BRIDGE_IMAGE" "$TRUSTED/deploy/gray-local" > "$run/build-bridge.log" 2>&1
build_image -f "$TRUSTED/deploy/gray-local/node.Dockerfile" -t "$GRAY_NODE_IMAGE" "$run/node-context" > "$run/build-node.log" 2>&1
docker pull registry:2 > "$run/build-registry.log" 2>&1
docker tag registry:2 "$GRAY_REGISTRY_IMAGE"
# G15 运行正式门户镜像中构建的候选 CLI。
mkdir -p "$run/src/build"
extract=$(docker create "$GRAY_PORTAL_IMAGE")
docker cp "$extract:/app/build/gpuctl.mjs" "$run/src/build/gpuctl.mjs"
docker rm "$extract" >/dev/null
extract=
compose config > "$run/compose.yml"
compose up -d > "$run/start.log" 2>&1
i=0
until compose exec -T gray-node-1 test -f /run/gray-node-ready 2>/dev/null; do
  i=$((i+1)); [ "$i" -lt 120 ] || { echo '节点安装超时' >&2; exit 1; }
  if compose exec -T gray-node-1 systemctl is-failed -q gray-node-setup 2>/dev/null; then
    compose exec -T gray-node-1 journalctl -b --no-pager > "$run/node-setup.log"
    echo "节点安装失败，见 $run/node-setup.log" >&2; exit 1
  fi
  sleep 5
done
compose restart gray-collector >/dev/null
i=0
until curl -fsS "http://127.0.0.1:$port/healthz" > "$run/health.json" 2>/dev/null; do
  i=$((i+1)); [ "$i" -lt 60 ] || { echo '门户未就绪' >&2; exit 1; }; sleep 2
done
node_python=$(compose exec -T gray-node-1 cat /run/gray-node-python)
python3 - "$run" "$commit" "$port" "$node_python" <<'PY'
import json,sys
from pathlib import Path
run,commit,port,node_python=sys.argv[1:]
stack=dict(source=json.loads(Path(run,'source.json').read_text()),nodePython=node_python,version=1,project='stargate-gray',origin=f'http://127.0.0.1:{port}',tier='cpu',machines=['gray-node-1'],cardsPerNode=2,adminPasswordFile='admin-password',commit=commit,nodeRelease=json.loads(Path(run,'node-release.json').read_text()))
Path(run,'stack.json').write_text(json.dumps(stack,indent=2))
PY
node "$TRUSTED/tests/gray/run.mjs" --stack "$run/stack.json" --level full --report "$run"
