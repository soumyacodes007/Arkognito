import { resolve } from "node:path"
import { defineConfig } from "vite"

export default defineConfig({
  // Inside the repo, load arkognito from source. Published consumers never set this condition.
  resolve: { conditions: ["arkognito-source", "module", "browser", "development|production"] },
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        index: resolve(__dirname, "index.html"),
        sketchPublic: resolve(__dirname, "sketch-public.html"),
        sketchPrivate: resolve(__dirname, "sketch-private.html"),
        observer: resolve(__dirname, "observer.html"),
        determinism: resolve(__dirname, "determinism.html"),
      },
    },
  },
  server: { port: 5173 },
})
