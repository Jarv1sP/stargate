#!/bin/sh
set -eu
base=/opt/gray
export STARGATE_VPS_CONFIG=$base/vps.json
case "${1:-}" in
bridge)
  umask 077
  mkdir -p "$base/executor" "$base/collector" "$base/status" /keys
  for role in executor collector; do
    if [ ! -s "$base/$role/id_ed25519" ]; then
      ssh-keygen -q -t ed25519 -N '' -C "gray-$role" -f "$base/$role/id_ed25519"
    fi
    cp "$base/$role/id_ed25519.pub" "/keys/$role.pub"
    chmod 644 "/keys/$role.pub"
  done
  chown 0:1000 "$base/status" /bridge
  chmod 750 "$base/status" /bridge
  nodes=$(python3 -c 'import json;print(" ".join(n["id"]+"="+n["address"] for n in json.load(open("/run-config/inventory.json"))["nodes"]))')
  : > "$base/executor/known_hosts"
  for pair in $nodes; do
    id=${pair%%=*}; address=${pair#*=}
    i=0
    until [ -s "/keys/hostkeys/$id.pub" ]; do
      i=$((i+1)); [ "$i" -lt 300 ] || exit 1; sleep 1
    done
    printf '%s %s\n' "$address" "$(cut -d' ' -f1,2 "/keys/hostkeys/$id.pub")" >> "$base/executor/known_hosts"
  done
  cp "$base/executor/known_hosts" "$base/collector/known_hosts"
  python3 - <<'PY'
import json,os
from pathlib import Path
hosts={n['id']:{'user':n['user'],'address':n['address']} for n in json.loads(Path('/run-config/inventory.json').read_text())['nodes']}
config=dict(transport=dict(credentialDirectory='/opt/gray/executor',hosts=hosts),
            bridge=dict(runtimeDirectory='/run/stargate-direct-node',socket='/bridge/bridge.sock',socketUid=0,socketGid=1000),
            collector=dict(credentialDirectory='/opt/gray/collector',hosts=hosts,target='/opt/gray/status/snapshot.json',targetUid=0,targetGid=1000))
target=Path(os.environ['STARGATE_VPS_CONFIG'])
temporary=target.with_suffix('.tmp')
temporary.write_text(json.dumps(config))
temporary.replace(target)
PY
  exec python3 /opt/stargate-vps/direct-storage-bridge.py
  ;;
collector)
  i=0
  until [ -s "$STARGATE_VPS_CONFIG" ]; do
    i=$((i+1)); [ "$i" -lt 600 ] || exit 1; sleep 1
  done
  trap 'exit 0' TERM INT
  while :; do
    python3 /opt/stargate-vps/collect-status.py || :
    sleep 60 & wait $!
  done
  ;;
*) exit 2 ;;
esac
