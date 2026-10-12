// "What can an observer see": reads the demo project straight from Arkiv, with no wallet and no
// help from anyone, and shows how well records group by person with and without Arkognito.
import { createPublicClient } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { eq } from "@arkiv-network/sdk/query"
import { http, isAddress } from "viem"
import { EXPLORER, PROJECT } from "./wallet"

const client = createPublicClient({ chain: tiramisu, transport: http() })
type Row = { key: string; owner: string; creator: string; createdAt: bigint; expiresAt: bigint; size: number }

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)

async function load(project: string): Promise<Row[]> {
  const rows: Row[] = []
  const q = client
    .select({ key: true, owner: true, creator: true, createdAt: true, expiresAt: true, payload: true })
    .where(eq("project", project))
    .limit(200)
  for await (const e of q) {
    rows.push({ key: e.key, owner: e.owner, creator: e.creator, createdAt: e.createdAt, expiresAt: e.expiresAt, size: e.payload.length })
    if (rows.length >= 1000) break
  }
  return rows
}

function groupBy<T>(xs: T[], k: (x: T) => string) {
  const m = new Map<string, T[]>()
  for (const x of xs) m.set(k(x), [...(m.get(k(x)) ?? []), x])
  return m
}

function summary(title: string, rows: Row[], note: string) {
  const owners = groupBy(rows, (r) => r.owner.toLowerCase())
  const creators = new Set(rows.map((r) => r.creator.toLowerCase()))
  const biggest = Math.max(0, ...[...owners.values()].map((v) => v.length))
  const sizes = new Set(rows.map((r) => r.size))
  return `
    <section class="card">
      <h2>${title}</h2>
      <p class="muted">${note}</p>
      <dl class="stats">
        <div><dt>Records</dt><dd>${rows.length}</dd></div>
        <div><dt>Distinct owners</dt><dd>${owners.size}</dd></div>
        <div><dt>Distinct creators</dt><dd>${creators.size}</dd></div>
        <div><dt>Most records one owner query returns</dt><dd>${biggest}</dd></div>
        <div><dt>Distinct payload sizes</dt><dd>${sizes.size}</dd></div>
      </dl>
      <details><summary>Records by owner</summary>
        <table><thead><tr><th>Owner</th><th>Records</th><th>Creator</th></tr></thead><tbody>
        ${[...owners.entries()]
          .sort((a, b) => b[1].length - a[1].length)
          .slice(0, 50)
          .map(([o, rs]) => `<tr><td class="mono">${short(o)}</td><td>${rs.length}</td><td class="mono">${short(rs[0].creator)}</td></tr>`)
          .join("")}
        </tbody></table>
      </details>
    </section>`
}

function batches(rows: Row[]) {
  const byBatch = groupBy(rows, (r) => `${r.createdAt}|${r.creator.toLowerCase()}`)
  const list = [...byBatch.entries()].sort((a, b) => Number(BigInt(b[0].split("|")[0]) - BigInt(a[0].split("|")[0]))).slice(0, 20)
  return `
    <section class="card">
      <h2>Arkognito batches, newest first</h2>
      <p class="muted">Each row is one transaction from a relayer. Order inside it is shuffled, every owner is new, and sizes are padded, so there is nothing to tell which record came from whom.</p>
      <table><thead><tr><th>Block</th><th>Records</th><th>Owners</th><th>Sizes (bytes)</th></tr></thead><tbody>
      ${list
        .map(([k, rs]) => `<tr><td>${k.split("|")[0]}</td><td>${rs.length}</td><td class="mono">${rs.map((r) => short(r.owner)).join(" ")}</td><td>${[...new Set(rs.map((r) => r.size))].join(", ")}</td></tr>`)
        .join("")}
      </tbody></table>
    </section>`
}

export async function mountObserver(root: HTMLElement) {
  root.innerHTML = `
    <section class="card">
      <h2>Owner query</h2>
      <p class="muted">The query anyone can run: <code>$owner = addr(…)</code>. Paste a wallet address.</p>
      <form id="q" class="row"><input id="addr" placeholder="0x…" spellcheck="false" aria-label="Wallet address"><button class="primary">Run query</button></form>
      <div id="qout"></div>
    </section>
    <div id="out"><p class="muted">Reading project <code>${PROJECT}</code> from Arkiv…</p></div>`
  const out = root.querySelector<HTMLElement>("#out")!
  let rows: Row[] = []
  try {
    rows = await load(PROJECT)
  } catch (e) {
    out.innerHTML = `<p class="status err">${esc((e as Error).message)}</p>`
    return
  }
  // A wallet that created its own sketch is the public Sketch App; a record created by someone else is Arkognito.
  const plain = rows.filter((r) => r.owner.toLowerCase() === r.creator.toLowerCase())
  const hidden = rows.filter((r) => r.owner.toLowerCase() !== r.creator.toLowerCase())
  out.innerHTML =
    `<div class="split">` +
    summary("Without Arkognito", plain, "Public Sketch App: your wallet creates and owns each sketch.") +
    summary("With Arkognito", hidden, "Private Sketch App: a shared relayer creates each sketch and hands it to a one-time owner.") +
    `</div>` +
    batches(hidden)

  root.querySelector<HTMLFormElement>("#q")!.onsubmit = async (ev) => {
    ev.preventDefault()
    const addr = root.querySelector<HTMLInputElement>("#addr")!.value.trim()
    const qout = root.querySelector<HTMLElement>("#qout")!
    if (!isAddress(addr)) return void (qout.innerHTML = `<p class="status err">Not an address.</p>`)
    qout.innerHTML = `<p class="muted">Querying…</p>`
    const { entities } = await client.select({ key: true, creator: true }).where(eq("project", PROJECT)).ownedBy(addr).fetch()
    qout.innerHTML = `<p><strong>${entities.length}</strong> record(s) owned by ${short(addr)}.</p>` +
      entities.slice(0, 20).map((e) => `<div class="mono"><a href="${EXPLORER}/entity/${e.key}" target="_blank" rel="noopener">${short(e.key)}</a> created by ${short(e.creator)}</div>`).join("")
  }
}
