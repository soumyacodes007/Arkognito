// Passkey roots in a real browser: headless Chrome with a WebAuthn virtual authenticator that
// supports the PRF extension, driven over the DevTools protocol. Needs the demo dev server running
// (npm run dev:demo) and Chrome installed.
//
//   CHROME=/path/to/chrome npx tsx tests/browser-passkey.ts
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { check, done, sleep } from "./helpers"

const chrome = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe"
const page = process.env.PAGE ?? "http://localhost:5173/test-passkey.html"
const port = 9333
const profile = mkdtempSync(join(tmpdir(), "arkognito-chrome-"))
const proc = spawn(chrome, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--headless=new", "--no-first-run", "about:blank"], { stdio: "ignore" })

async function json<T>(path: string, method = "GET"): Promise<T> {
  for (let i = 0; i < 50; i++) {
    try {
      return (await (await fetch(`http://127.0.0.1:${port}${path}`, { method })).json()) as T
    } catch {
      await sleep(200)
    }
  }
  throw new Error("Chrome did not start")
}

try {
  const target = await json<{ webSocketDebuggerUrl: string }>("/json/new?about:blank", "PUT")
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)))
  let seq = 0
  const pending = new Map<number, (v: { result?: unknown; error?: { message: string } }) => void>()
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data))
    if (m.id && pending.has(m.id)) pending.get(m.id)!(m)
  }
  const send = async <T>(method: string, params: object = {}): Promise<T> => {
    const id = ++seq
    const reply = await new Promise<{ result?: unknown; error?: { message: string } }>((r) => {
      pending.set(id, r)
      ws.send(JSON.stringify({ id, method, params }))
    })
    if (reply.error) throw new Error(`${method}: ${reply.error.message}`)
    return reply.result as T
  }

  await send("WebAuthn.enable", { enableUI: false })
  await send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: true,
      automaticPresenceSimulation: true,
    },
  })
  await send("Page.enable")
  await send("Runtime.enable")
  await send("Page.navigate", { url: page })

  let text = ""
  for (let i = 0; i < 60; i++) {
    await sleep(1000)
    const r = await send<{ result: { value?: string } }>("Runtime.evaluate", {
      expression: `document.getElementById("out")?.dataset.done ? document.getElementById("out").textContent : ""`,
      returnByValue: true,
    })
    text = r.result.value ?? ""
    if (text) break
  }
  if (!text) throw new Error("the test page did not finish")
  const out = JSON.parse(text) as { pass: boolean; results: { name: string; ok: boolean; detail?: string }[] }
  for (const r of out.results) check(`browser: ${r.name}`, r.ok, r.detail)
  ws.close()
} catch (e) {
  check("browser passkey test ran", false, (e as Error).message)
} finally {
  proc.kill()
  await sleep(500)
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {
    // Chrome may still hold the profile for a moment
  }
}
done()
process.exit(process.exitCode ?? 0)
