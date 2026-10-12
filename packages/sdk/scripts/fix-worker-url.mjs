// tsc rewrites import specifiers but not URL strings: point the worker URL at the emitted .js file.
import { readFileSync, writeFileSync } from "node:fs"

const file = new URL("../dist/worker-vault.js", import.meta.url)
const src = readFileSync(file, "utf8")
const out = src.replace('new URL("./vault.worker.ts", import.meta.url)', 'new URL("./vault.worker.js", import.meta.url)')
if (out === src) throw new Error("worker URL not found in dist/worker-vault.js")
writeFileSync(file, out)
