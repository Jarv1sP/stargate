#!/bin/sh
set -eu
base=/opt/gray
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
  for pair in $nodes; do
    id=${pair%%=*}; address=${pair#*=}
    i=0
    until [ -s "/keys/hostkeys/$id.pub" ]; do
      i=$((i+1)); [ "$i" -lt 300 ] || exit 1; sleep 1
    done
    printf '%s %s\n' "$address" "$(cut -d' ' -f1,2 "/keys/hostkeys/$id.pub")" > "$base/executor/known_hosts"
  done
  cp "$base/executor/known_hosts" "$base/collector/known_hosts"
  exec python3 /opt/gray-src/gray-bridge.py
  ;;
collector)
  i=0
  until [ -s "$base/collector/known_hosts" ]; do
    i=$((i+1)); [ "$i" -lt 600 ] || exit 1; sleep 1
  done
  exec python3 /opt/gray-src/gray-collector.py
  ;;
*) exit 2 ;;
esac
