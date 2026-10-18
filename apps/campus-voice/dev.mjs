// Runs the story server and the web app together: `npm run dev -w campus-voice`.
import { spawn, spawnSync } from "node:child_process"

const win = process.platform === "win32"
const run = (script) => spawn(win ? "npm.cmd" : "npm", ["run", script], { stdio: "inherit", shell: win })
const children = [run("server"), run("web")]

let stopping = false
function stop(code = 0) {
  if (stopping) return
  stopping = true
  for (const c of children) {
    if (c.exitCode !== null) continue
    // On Windows, killing npm's shell leaves vite/tsx running: stop the whole tree.
    if (win) spawnSync("taskkill", ["/pid", String(c.pid), "/T", "/F"], { stdio: "ignore" })
    else c.kill("SIGTERM")
  }
  process.exit(code)
}
process.on("SIGINT", () => stop())
process.on("SIGTERM", () => stop())
for (const c of children) c.on("exit", (code) => stop(code ?? 0))
