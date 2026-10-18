# Campus Voice, deployed: one port serves the page, the story server and its relayer.
# Build from the repo root:  docker build -f apps/campus-voice/Dockerfile .
# Needs TEST_RELAYER_A_PRIVATE_KEY and TEST_RELAYER_B_PRIVATE_KEY (funded, synthetic demo wallets);
# optional CAMPUS_ARKIV_ACCESS_KEY.
FROM node:22-slim
WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
COPY packages/sdk/package.json packages/sdk/
COPY packages/relayer/package.json packages/relayer/
COPY apps/demo/package.json apps/demo/
COPY apps/campus-voice/package.json apps/campus-voice/
RUN npm ci --no-audit --no-fund

COPY docs/semaphore.md docs/
COPY packages/sdk packages/sdk
COPY packages/relayer packages/relayer
COPY apps/campus-voice apps/campus-voice
RUN npm run build -w arkognito && npm run build -w campus-voice

# Depth-3 Semaphore proving files, checked against the digests in docs/semaphore.md.
RUN node -e "const {createHash}=require('crypto'),fs=require('fs');fs.mkdirSync('spikes/s1-semaphore-node/artifacts',{recursive:true});const want={wasm:'48e15502f710be0a623d573d472edeeaf918fd5eee0b2ca9b407c4e4f20d12f2',zkey:'c36653c42784df35a01f3d93415af9ad8292a540f8deb134a6a34a01752a89d3'};(async()=>{for(const [ext,sha] of Object.entries(want)){const b=Buffer.from(await (await fetch('https://snark-artifacts.pse.dev/semaphore/4.13.0/semaphore-3.'+ext)).arrayBuffer());if(createHash('sha256').update(b).digest('hex')!==sha)throw Error('digest mismatch '+ext);fs.writeFileSync('spikes/s1-semaphore-node/artifacts/semaphore-3.'+ext,b)}})().catch(e=>{console.error(e);process.exit(1)})"

RUN mkdir -p apps/campus-voice/.state && chown -R node:node apps/campus-voice/.state
ENV NODE_ENV=production CAMPUS_STATIC=on PORT=8790
EXPOSE 8790
USER node
CMD ["npx", "tsx", "--conditions=arkognito-source", "apps/campus-voice/server/serve.ts"]
