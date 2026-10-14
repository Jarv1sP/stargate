FROM node:24-bookworm-slim AS client-builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
# .dockerignore admits only application inputs, fixed helpers, and build scripts.
COPY . .
ARG STARGATE_RELEASE_REVISION
RUN STARGATE_RELEASE_REVISION="$STARGATE_RELEASE_REVISION" npm run build && npm prune --omit=dev --ignore-scripts
RUN mkdir -p /runtime/build \
    && cp *.mjs package.json /runtime/ \
    && cp -R dist docs deploy /runtime/ \
    && cp build/gpuctl.mjs /runtime/build/ \
    && if [ -d tasks ]; then cp -R tasks /runtime/; fi

FROM node:24-bookworm-slim
WORKDIR /app
COPY --from=client-builder --chown=root:root /runtime/ ./
COPY --from=client-builder --chown=root:root /app/node_modules ./node_modules
USER node
RUN node --input-type=module -e "await import('./portal-server.mjs')"
RUN test -s dist/vendor/xterm.js && test -s dist/vendor/xterm.css \
    && test -s dist/vendor/addon-fit.js \
    && test -s dist/vendor/XTERM-LICENSE && test -s dist/vendor/ADDON-FIT-LICENSE
EXPOSE 8080
CMD ["node", "portal-server.mjs"]
