FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 openssh-client ca-certificates git && rm -rf /var/lib/apt/lists/*
COPY gray-bridge.py gray-collector.py /opt/gray-src/
COPY bridge-entrypoint.sh /usr/local/bin/gray-bridge
ENTRYPOINT ["/bin/sh", "/usr/local/bin/gray-bridge"]
