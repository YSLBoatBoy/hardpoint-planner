FROM node:22-alpine

LABEL org.opencontainers.image.title="Hardpoint Planner" \
      org.opencontainers.image.description="Star Citizen loadout optimizer with store locations and Gemini-powered ship Q&A" \
      org.opencontainers.image.source="https://github.com/YSLBoatBoy/hardpoint-planner"

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    NODE_OPTIONS=--max-old-space-size=1024

COPY package.json ./
COPY server ./server
COPY public ./public
COPY seed ./seed

# Unraid's appdata shares are owned by nobody:users (99:100), so run as that user.
RUN mkdir -p /data && chown -R 99:100 /data
USER 99:100

EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1

CMD ["node", "server/index.js"]
