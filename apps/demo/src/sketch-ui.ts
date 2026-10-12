// Drawing canvas and gallery, shared by the public and private Sketch App pages.
import { EXPLORER } from "./wallet"

/** A sketch is a list of strokes; each stroke is a flat [x0, y0, x1, y1, ...] list on a 256 grid. */
export type Sketch = { strokes: number[][] }
export type SketchStore = {
  account: string
  save(s: Sketch): Promise<{ entityKey: string; batchSize?: number }>
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

export function mountSketchApp(root: HTMLElement, openStore: () => Promise<SketchStore>, mode: "public" | "private") {
  root.innerHTML = `
    <section class="card">
      <div class="row">
        <button id="connect" class="primary">Connect MetaMask</button>
        <span id="who" class="muted"></span>
      </div>
      <canvas id="pad" width="${SIZE * 2}" height="${SIZE * 2}" aria-label="Drawing canvas"></canvas>
      <div class="row">
        <button id="clear">Clear</button>
        <button id="save" class="primary" disabled>Save sketch</button>
        <span id="points" class="muted"></span>
      </div>
      <p id="status" class="status" role="status"></p>
    </section>
    <section class="card">
      <div class="row"><h2>My sketches</h2><button id="refresh" disabled>Refresh</button></div>
      <div id="gallery" class="gallery"></div>
    </section>`

  const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!
  const pad = $<HTMLCanvasElement>("pad")
  const ctx = pad.getContext("2d")!
  const status = (msg: string, kind: "" | "ok" | "err" = "") => {
    const el = $("status")
    el.textContent = msg
    el.className = `status ${kind}`
  }
  let sketch: Sketch = { strokes: [] }
  let store: SketchStore | undefined
  const points = () => sketch.strokes.reduce((n, s) => n + s.length / 2, 0)
  const redraw = () => {
    draw(ctx, sketch, 2)
    $("points").textContent = `${points()} / ${MAX_POINTS} points`
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

  async function refresh() {
    if (!store) return
    const gallery = $("gallery")
    gallery.innerHTML = `<p class="muted">Loading…</p>`
    try {
      const items = await store.list()
      gallery.innerHTML = items.length ? "" : `<p class="muted">No sketches yet.</p>`
      for (const it of items) {
        const fig = document.createElement("figure")
        const c = document.createElement("canvas")
        c.width = c.height = 128
        draw(c.getContext("2d")!, it, 0.5)
        const cap = document.createElement("figcaption")
        cap.innerHTML = `<a href="${EXPLORER}/entity/${it.key}" target="_blank" rel="noopener">${it.key.slice(0, 10)}…</a>`
        fig.append(c, cap)
        gallery.append(fig)
      }
    } catch (e) {
      gallery.innerHTML = `<p class="status err">${(e as Error).message}</p>`
    }
  }

  $("connect").onclick = async () => {
    try {
      status(mode === "private" ? "Connecting. MetaMask will ask you to sign the Arkognito key message (twice, to check it is stable)…" : "Connecting…")
      store = await openStore()
      $("who").textContent = `Connected ${store.account.slice(0, 6)}…${store.account.slice(-4)}`
      $<HTMLButtonElement>("save").disabled = false
      $<HTMLButtonElement>("refresh").disabled = false
      $<HTMLButtonElement>("connect").disabled = true
      status("Connected.", "ok")
      await refresh()
    } catch (e) {
      status((e as Error).message, "err")
    }
  }
  $("refresh").onclick = () => void refresh()
  $("save").onclick = async () => {
    if (!store || sketch.strokes.length === 0) return status("Draw something first.", "err")
    $<HTMLButtonElement>("save").disabled = true
    status(mode === "private" ? "Sending to the relayer; it waits for a batch, so this can take up to a minute…" : "Confirm in MetaMask…")
    try {
      const res = await store.save(sketch)
      const batch = res.batchSize ? ` You were 1 of ${res.batchSize} records in that batch.` : ""
      status(`Saved ${res.entityKey.slice(0, 12)}….${batch}`, "ok")
      sketch = { strokes: [] }
      redraw()
      await refresh()
    } catch (e) {
      status((e as Error).message, "err")
    } finally {
      $<HTMLButtonElement>("save").disabled = false
    }
  }
  redraw()
}
