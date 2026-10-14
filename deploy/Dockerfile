FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS client-builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY *.mjs ./
COPY dist ./dist
COPY scripts/build-client.mjs ./scripts/
RUN npm run build:client
RUN npm prune --omit=dev --ignore-scripts

FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
WORKDIR /app
COPY --from=client-builder --chown=root:root /app/build/gpuctl.mjs ./build/gpuctl.mjs
COPY --from=client-builder --chown=root:root /app/node_modules ./node_modules
# Includes the STARGATE apple-touch icon and all self-hosted frontend assets.
COPY --chown=root:root dist ./dist
COPY --chown=root:root portal-server.mjs portal-service.mjs oci-cohort.mjs frontend-assets.mjs community.mjs maintenance.mjs execution.mjs job-submission.mjs task-catalog.mjs projects.mjs project-catalog.mjs snapshot-sync.mjs gpuq-status.mjs cli.mjs job-watch.mjs job-notifications.mjs client-bundle.mjs client-http.mjs direct-upload-policy.mjs guide.mjs package.json ./
COPY --chown=root:root cloud-import.mjs aliyun-share.mjs community-cli.mjs cli-help.mjs ./
COPY --chown=root:root clouddrive-provider.mjs ./
COPY --chown=root:root proto/clouddrive-pilot.proto ./proto/
COPY --chown=root:root dataset-catalog.mjs dataset-storage-overview.mjs dataset-files.mjs dataset-cache-actions.mjs dataset-preparation.mjs dataset-replication.mjs dataset-deletion.mjs storage-archive.mjs dataset-ingress.mjs ./
COPY --chown=root:root project-replication.mjs admin-project-copy.mjs machine-selection.mjs ./
COPY --chown=root:root training-datasets.mjs training-storage.mjs training-preparation.mjs ./
COPY --chown=root:root dataset-labels.mjs ./
COPY --chown=root:root storage-usage.mjs ./
COPY --chown=root:root task-display.mjs ./
COPY --chown=root:root docs/USER_GUIDE.md ./docs/
COPY --chown=root:root deploy/install-client.sh deploy/install-client.ps1 ./deploy/
COPY --chown=root:root transfers.mjs ./
COPY --chown=root:root login-sessions.mjs ./
COPY --chown=root:root native-task-metadata.mjs job-observation.mjs ./
USER node
# Load the final image's module graph as its runtime user. Importing the Portal
# does not start it, open SQLite or contact the execution bridge.
RUN node --input-type=module -e "await import('./portal-server.mjs')"
RUN test -s dist/dataset-remove-ui.js && test -s dist/dataset-remove.css
EXPOSE 8080
CMD ["node", "portal-server.mjs"]
