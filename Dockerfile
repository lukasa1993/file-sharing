FROM --platform=$BUILDPLATFORM oven/bun:1.4.5@sha256:3aa040e5445efa09d75bb428a64ba50db13e2b3ac9b6b0c7f145615f62b2ee18 AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
ARG TARGETARCH
RUN --mount=type=secret,id=registry_ca \
    if [ -f /run/secrets/registry_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/registry_ca; fi && \
    case "$TARGETARCH" in amd64) cpu=x64;; arm64) cpu=arm64;; *) exit 1;; esac && \
    bun install --production --frozen-lockfile --ignore-scripts --os linux --cpu "$cpu"

FROM dependencies AS build
COPY tsconfig.json server.ts ./
COPY app ./app
COPY shared ./shared
COPY public ./public
COPY scripts/build.ts ./scripts/build.ts
COPY scripts/ops.ts scripts/storage-inventory.ts ./scripts/
RUN bun scripts/build.ts && mkdir -p /app/operator/scripts && \
    bun build --target bun --packages external scripts/ops.ts --outfile /app/operator/scripts/ops.ts && \
    chmod -R a+rX /app/dist /app/operator

FROM oven/bun:1.4.5@sha256:3aa040e5445efa09d75bb428a64ba50db13e2b3ac9b6b0c7f145615f62b2ee18
WORKDIR /app
ENV NODE_ENV=production PORT=8080 DATA_DIR=/var/lib/fileserver CONFIG_FILE=/etc/fileserver/mounts.json SESSION_SECRET_FILE=/etc/fileserver/session.key BOOTSTRAP_FILE=/etc/fileserver/bootstrap.json
COPY --from=dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun --chmod=0444 package.json ./
COPY --from=build --chown=bun:bun /app/dist ./dist
COPY --from=build --chown=bun:bun /app/operator/ ./
USER bun
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["bun","-e","const r=await fetch('http://127.0.0.1:'+process.env.PORT+'/readyz',{headers:{Host:new URL(process.env.PUBLIC_ORIGIN).host},signal:AbortSignal.timeout(3500)});process.exit(r.status===200?0:1)"]
ENTRYPOINT ["bun"]
CMD ["run", "dist/app/server.js"]
