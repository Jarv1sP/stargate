#!/bin/sh
set -eu
run=${1:?请提供本轮 out/gray 目录}
docker compose -p stargate-gray -f "$run/compose.yml" down -v --remove-orphans
docker ps -a --filter label=com.docker.compose.project=stargate-gray
docker volume ls --filter label=com.docker.compose.project=stargate-gray
docker network ls --filter label=com.docker.compose.project=stargate-gray
[ -z "$(docker ps -aq --filter name=stargate-gray)" ] || { echo '仍有灰度容器'; exit 1; }
[ -z "$(docker volume ls -q --filter name=stargate-gray)" ] || { echo '仍有灰度卷'; exit 1; }
[ -z "$(docker network ls -q --filter name=stargate-gray)" ] || { echo '仍有灰度网络'; exit 1; }
losetup -a > "$run/loops-after.txt"
diff -u "$run/loops-before.txt" "$run/loops-after.txt"
