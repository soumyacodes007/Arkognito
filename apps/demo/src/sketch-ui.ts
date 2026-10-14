// Drawing canvas, save timeline and gallery, shared by the public and private Sketch App pages.
import { type PromptCount, esc, explorer, extLink, icon, short, watchWalletPrompts } from "./layout"

/** A sketch is a list of strokes; each stroke is a flat [x0, y0, x1, y1, ...] list on a 256 grid. */
export type Sketch = { strokes: number[][] }
export type SaveResult = { entityKey: string; batchSize?: number; txHash?: string; owner?: string }
export type SketchStore = {
  account: string
  save(s: Sketch): Promise<SaveResult>
  list(): Promise<(Sketch & { key: string })[]>
}

const SIZE = 256
const MAX_POINTS = 1500

function draw(ctx: CanvasRenderingContext2D, sketch: Sketch, scale: number) {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)
  ctx.lineCap = "round"
  ctx.lineJoin = "round"
  ctx.lineWidth = 3 * scale
  ctx.strokeStyle = getComputedStyle(document.body).getPropertyValue("--ink").trim() || "#111"
  for (const s of sketch.strokes) {
    ctx.beginPath()
    for (let i = 0; i < s.length; i += 2) {
      const [x, y] = [s[i] * scale, s[i + 1] * scale]
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    if (s.length === 2) ctx.lineTo(s[0] * scale + 0.1, s[1] * scale)
    ctx.stroke()
  }
}

type StepState = "todo" | "active" | "done" | "fail"
type Step = { title: string; detail: string; state: StepState; when?: string }

const DIFF = [
  `<span class="del">- const arkiv = createWalletClient({ chain, transport, account })</span>`,
  `<span class="add">+ const arkiv = await createPrivateClient({ app: PROJECT, wallet: createWalletClient({ chain, transport, account }) })</span>`,
  `<span class="ctx">  save: (sketch) => arkiv.createEntity({ payload, contentType, attributes, expires }),</span>`,
  `<span class="del">- list: () => publicClient.select(...).ownedBy(account).fetch()</span>`,
  `<span class="add">+ list: () => arkiv.myEntities({ where: { type: "sketch" } })</span>`,
].join("")

export function mountSketchApp(root: HTMLElement, openStore: () => Promise<SketchStore>, mode: "public" | "private") {
  const priv = mode === "private"
  root.innerHTML = `
    <div class="grid-2">
      <section class="card">
        <div class="card-head">${icon.pen}<h2>Canvas</h2><span class="sub">256 × 256 · saved as JSON strokes</span></div>
        <div class="card-body"><div class="canvas-wrap"><canvas id="pad" width="${SIZE * 2}" height="${SIZE * 2}" aria-label="Drawing canvas"></canvas></div></div>
        <div class="card-foot">
          <button id="clear" class="ghost">Clear</button>
          <button id="save" class="primary" disabled>Save sketch</button>
          <span id="points" class="counter"></span>
        </div>
      </section>
      <div class="stack">
        <section class="card">
          <div class="card-head"><h2>Session</h2><span class="sub">what your wallet was asked to do</span></div>
          <div class="card-body">
            <dl class="meter">
              <div><dt>Wallet</dt><dd id="who" style="font-size:15px;font-weight:500;padding-top:6px">Not connected</dd></div>
              <div><dt>Signatures</dt><dd id="n-sig">0</dd></div>
              <div><dt>Transactions</dt><dd id="n-tx">0</dd></div>
              <div><dt>Gas paid by you</dt><dd id="gas" style="font-size:15px;font-weight:500;padding-top:6px">${priv ? "None" : "Every save"}</dd></div>
            </dl>
          </div>
          <div class="card-foot">
            <button id="connect" class="primary">Connect MetaMask</button>
            <p id="status" class="status" role="status"></p>
          </div>
        </section>
        <section class="card">
          <div class="card-head"><h2>Last save</h2><span class="sub" id="elapsed"></span></div>
          <div class="card-body"><ol class="steps" id="steps"></ol></div>
          ${priv ? `<details class="toggle"><summary>What changed from the public app</summary><div class="toggle-body"><pre class="code">${DIFF}</pre></div></details>` : ""}
        </section>
      </div>
    </div>
    <section class="section">
      <div class="section-title"><h2>My sketches</h2><span class="faint" id="count"></span><span class="spacer" style="flex:1"></span><button id="refresh" disabled>Refresh</button></div>
      <div id="gallery" class="gallery"><div class="empty" style="grid-column:1/-1">Connect to see your sketches.</div></div>
    </section>`

  const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!
  const pad = $<HTMLCanvasElement>("pad")
  const ctx = pad.getContext("2d")!
  const status = (msg: string, kind: "" | "ok" | "err" | "busy" = "") => {
    const el = $("status")
    el.innerHTML = msg ? `${kind === "busy" ? `<span class="spinner" style="margin-top:3px"></span>` : ""}<span>${esc(msg)}</span>` : ""
    el.className = `status ${kind === "busy" ? "" : kind}`
  }
  const showCount = (c: PromptCount) => {
    $("n-sig").textContent = String(c.signatures)
    $("n-tx").textContent = String(c.transactions)
  }
  watchWalletPrompts(showCount)

  // ---- timeline -----------------------------------------------------------------------------
  const steps: Step[] = priv
    ? [
        { title: "Connect wallet", detail: "One signature (two the first time on this device). Keys are derived in a Web Worker.", state: "todo" },
        { title: "Rate-limit tokens ready", detail: "Blind tokens, fetched in the background with no prompt.", state: "todo" },
        { title: "Sent to a shared relayer", detail: "No transaction from your wallet.", state: "todo" },
        { title: "Landed in a shuffled batch", detail: "Written together with other people's records.", state: "todo" },
        { title: "Owned by a one-time address", detail: "A fresh owner, used once, linked to nothing.", state: "todo" },
      ]
    : [
        { title: "Connect wallet", detail: "MetaMask on Tiramisu.", state: "todo" },
        { title: "Confirm the transaction", detail: "Your wallet sends it and pays the gas.", state: "todo" },
        { title: "Landed on Arkiv", detail: "Created by your wallet.", state: "todo" },
        { title: "Owned by your wallet", detail: "One owner query on your address lists every sketch.", state: "todo" },
      ]
  const initial = steps.map((s) => s.detail)
  const renderSteps = () => {
    $("steps").innerHTML = steps
      .map((s) => `<li class="${s.state}"><span class="st"></span><div><div>${esc(s.title)}</div><div class="detail">${s.detail}</div></div><span class="when">${s.when ?? ""}</span></li>`)
      .join("")
  }
  const set = (i: number, state: StepState, detail?: string, when?: string) => {
    steps[i] = { ...steps[i], state, ...(detail !== undefined ? { detail } : {}), ...(when !== undefined ? { when } : {}) }
    renderSteps()
  }
  let timer: ReturnType<typeof setInterval> | undefined
  const startClock = () => {
    const t0 = performance.now()
    clearInterval(timer)
    timer = setInterval(() => ($("elapsed").textContent = `${((performance.now() - t0) / 1000).toFixed(1)} s`), 100)
    return () => {
      clearInterval(timer)
      return (performance.now() - t0) / 1000
    }
  }
  renderSteps()

  // ---- drawing --------------------------------------------------------------------------------
  let sketch: Sketch = { strokes: [] }
  let store: SketchStore | undefined
  const points = () => sketch.strokes.reduce((n, s) => n + s.length / 2, 0)
  const redraw = () => {
    draw(ctx, sketch, 2)
    $("points").textContent = `${points()} / ${MAX_POINTS} pts`
  }
  let drawing = false
  const at = (e: PointerEvent) => {
    const r = pad.getBoundingClientRect()
    const clamp = (v: number) => Math.max(0, Math.min(SIZE - 1, Math.round(v)))
    return [clamp(((e.clientX - r.left) / r.width) * SIZE), clamp(((e.clientY - r.top) / r.height) * SIZE)]
  }
  pad.addEventListener("pointerdown", (e) => {
    if (points() >= MAX_POINTS) return
    drawing = true
    pad.setPointerCapture(e.pointerId)
    sketch.strokes.push(at(e))
    redraw()
  })
  pad.addEventListener("pointermove", (e) => {
    if (!drawing || points() >= MAX_POINTS) return
    const s = sketch.strokes.at(-1)!
    const [x, y] = at(e)
    if (x !== s.at(-2) || y !== s.at(-1)) s.push(x, y)
    redraw()
  })
  pad.addEventListener("pointerup", () => (drawing = false))
  $("clear").onclick = () => {
    sketch = { strokes: [] }
    redraw()
  }

  // ---- gallery --------------------------------------------------------------------------------
  async function refresh() {
    if (!store) return
    const gallery = $("gallery")
    gallery.innerHTML = `<div class="empty" style="grid-column:1/-1"><span class="spinner" style="display:inline-block;vertical-align:-2px;margin-right:8px"></span>Reading from Arkiv…</div>`
    try {
      const items = await store.list()
      $("count").textContent = items.length ? `${items.length}` : ""
      gallery.innerHTML = items.length ? "" : `<div class="empty" style="grid-column:1/-1">No sketches yet. Draw one and save it.</div>`
      for (const it of items) {
        const fig = document.createElement("figure")
        const c = document.createElement("canvas")
        c.width = c.height = 192
        draw(c.getContext("2d")!, it, 0.75)
        const cap = document.createElement("figcaption")
        cap.innerHTML = `<a href="${explorer.entity(it.key)}" target="_blank" rel="noopener">${short(it.key, 6)}</a><span class="faint">${priv ? "one-time owner" : "owned by your wallet"}</span>`
        fig.append(c, cap)
        gallery.append(fig)
      }
    } catch (e) {
      gallery.innerHTML = `<div class="empty" style="grid-column:1/-1;color:var(--err)">${esc((e as Error).message)}</div>`
    }
  }

  // ---- connect and save ----------------------------------------------------------------------
  $("connect").onclick = async () => {
    try {
      set(0, "active")
      status(priv ? "Sign the Arkognito key message in MetaMask…" : "Connecting…", "busy")
      store = await openStore()
      $("who").innerHTML = extLink(explorer.address(store.account), short(store.account), "ext mono")
      set(0, "done", priv ? "Keys derived from one signature, held in a Web Worker." : `Connected ${short(store.account)}.`)
      if (priv) set(1, "done")
      $<HTMLButtonElement>("save").disabled = false
      $<HTMLButtonElement>("refresh").disabled = false
      $<HTMLButtonElement>("connect").disabled = true
      $("connect").textContent = "Connected"
      status("")
      await refresh()
    } catch (e) {
      set(0, "fail", esc((e as Error).message))
      status((e as Error).message, "err")
    }
  }
  $("refresh").onclick = () => void refresh()
  $("save").onclick = async () => {
    if (!store) return
    if (sketch.strokes.length === 0) return status("Draw something first.", "err")
    $<HTMLButtonElement>("save").disabled = true
    for (let i = priv ? 2 : 1; i < steps.length; i++) set(i, "todo", initial[i], "")
    const stop = startClock()
    const first = priv ? 2 : 1
    set(first, "active", priv ? "Waiting for other records to share the batch (up to ~30 s)." : "Confirm in MetaMask.")
    status(priv ? "Saving privately…" : "Confirm in MetaMask…", "busy")
    try {
      const res = await store.save(sketch)
      const secs = `${stop().toFixed(1)} s`
      const tx = res.txHash ? extLink(explorer.tx(res.txHash), short(res.txHash, 6)) : "transaction"
      const entity = extLink(explorer.entity(res.entityKey), short(res.entityKey, 6))
      if (priv) {
        set(2, "done", "No transaction from your wallet.")
        set(3, "done", `You were 1 of ${res.batchSize ?? "?"} records in ${tx}.`, secs)
        set(4, "done", `${res.owner ? extLink(explorer.address(res.owner), short(res.owner)) : "A fresh address"} owns ${entity}. Created by the relayer, never used before.`)
      } else {
        set(1, "done", "Sent and paid for by your wallet.")
        set(2, "done", `Sketch ${entity} in ${tx}.`, secs)
        set(3, "done", `${extLink(explorer.address(store.account), short(store.account))} owns it. Anyone can list all of your sketches.`)
      }
      status("Saved.", "ok")
      sketch = { strokes: [] }
      redraw()
      await refresh()
    } catch (e) {
      stop()
      set(first, "fail", esc((e as Error).message))
      status((e as Error).message, "err")
    } finally {
      $<HTMLButtonElement>("save").disabled = false
    }
  }
  redraw()
}
