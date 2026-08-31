# Agent Ecosystem — mission-control dashboard + API.
# Zero runtime dependencies, so there is no install step and no lockfile to honor.
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY agent-ecosystem.html ./
COPY agents/ ./agents/
COPY seed/ ./seed/

# Runtime data lives in /data, not /app. That keeps the application code owned by
# root and read-only to the runtime user, so a bug in the app cannot rewrite its
# own source. agents/lib.js and seed/seed.js both honor ECOSYS_DATA_DIR.
RUN mkdir -p /data && chown -R node:node /data
USER node
ENV ECOSYS_DATA_DIR=/data

# A container must bind all interfaces to be reachable. The startup interlock in
# server.js therefore REQUIRES ECOSYS_TOKEN here — running this image without one
# is a deliberate hard failure, not an oversight.
ENV ECOSYS_BIND=0.0.0.0
ENV ECOSYS_PORT=4242
EXPOSE 4242

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.ECOSYS_PORT||4242)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Seed the synthetic demo dataset on first boot (no-op if data already exists),
# then serve. Real pipeline data never ships in the image — see .dockerignore.
CMD ["sh", "-c", "node seed/seed.js && node server.js"]
