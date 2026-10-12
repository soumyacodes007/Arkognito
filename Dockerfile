# Arkognito services. One image, three roles (set ROLE):
#   ROLE=relayer      relayer; ISSUER=on also runs the token issuer
#   ROLE=ohttp-relay  Oblivious HTTP relay
FROM node:22-slim
WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
COPY packages/sdk/package.json packages/sdk/
COPY packages/relayer/package.json packages/relayer/
COPY apps/demo/package.json apps/demo/
RUN npm ci --no-audit --no-fund

COPY packages/sdk packages/sdk
COPY packages/relayer packages/relayer
RUN npm run build -w arkognito

# Issuer quota file lives here (mount a volume to keep quotas across restarts).
RUN mkdir -p /data && chown node:node /data

ENV NODE_ENV=production ROLE=relayer PORT=8787
EXPOSE 8787
USER node
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["npx", "tsx", "packages/relayer/src/start.ts"]
