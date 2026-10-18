import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const api = `http://127.0.0.1:${process.env.CAMPUS_API_PORT ?? 8790}`
const relay = `http://127.0.0.1:${process.env.CAMPUS_RELAY_PORT ?? 8791}`

export default defineConfig({
  plugins: [react()],
  // Inside the repo, load arkognito from source. Published consumers never set this condition.
  resolve: { conditions: ["arkognito-source", "module", "browser", "development|production"] },
  build: { target: "es2022" },
  // Prepared up front: discovered mid-story, they would make the dev server reload the page.
  optimizeDeps: { include: ["@anon-aadhaar/core", "@semaphore-protocol/proof", "buffer", "jsqr", "qrcode", "zxing-wasm/reader"] },
  server: {
    port: 5180,
    // Same origin for everything the page talks to: the story server, the relayer and Arkiv reads.
    proxy: {
      "/api": api,
      "/rpc": api,
      "/artifacts": api,
      "/relay": { target: relay, rewrite: (p) => p.replace(/^\/relay/, "") },
    },
  },
})
