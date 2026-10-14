// "What can an observer see": reads the demo project straight from Arkiv, with no wallet and no
// help from anyone, and shows how well records group by person with and without Arkognito.
import { eq } from "@arkiv-network/sdk/query"
import { isAddress } from "viem"
import { esc, explorer, extLink, icon, reader as client, short } from "./layout"
import { PROJECT } from "./wallet"

type Row = { key: string; owner: string; creator: string; createdAt: bigint; expiresAt: bigint; size: number }

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

function summary(title: string, rows: Row[], note: string, privateSide: boolean) {
  const owners = groupBy(rows, (r) => r.owner.toLowerCase())
  const creators = new Set(rows.map((r) => r.creator.toLowerCase()))
  const biggest = Math.max(0, ...[...owners.values()].map((v) => v.length))
  const sizes = new Set(rows.map((r) => r.size))
  const linked = privateSide ? (biggest <= 1 ? "good" : "bad") : biggest > 1 ? "bad" : ""
  return `
    <section class="card">
      <div class="card-head">${privateSide ? icon.lock : icon.eye}<h2>${title}</h2></div>
      <div class="card-body"><p class="muted" style="font-size:14px">${note}</p></div>
      <dl class="metrics">
        <div><dt>Records</dt><dd>${rows.length}</dd></div>
        <div><dt>Distinct owners</dt><dd>${owners.size}</dd></div>
        <div><dt>Distinct creators</dt><dd>${creators.size}</dd></div>
        <div><dt>Largest group one owner query returns</dt><dd class="${linked}">${biggest}</dd></div>
        <div><dt>Distinct payload sizes</dt><dd>${sizes.size}</dd></div>
      </dl>
      <details class="toggle"><summary>Records by owner</summary>
        <div class="toggle-body table-scroll">
          <table class="db"><thead><tr><th>Owner</th><th>Records</th><th>Creator</th></tr></thead><tbody>
          ${[...owners.entries()]
            .sort((a, b) => b[1].length - a[1].length)
            .slice(0, 50)
            .map(([o, rs]) => `<tr><td class="mono-cell">${extLink(explorer.address(o), short(o))}</td><td>${rs.length}</td><td class="mono-cell">${extLink(explorer.address(rs[0].creator), short(rs[0].creator))}</td></tr>`)
            .join("")}
          </tbody></table>
        </div>
      </details>
    </section>`
}

function batches(rows: Row[]) {
  const byBatch = groupBy(rows, (r) => `${r.createdAt}|${r.creator.toLowerCase()}`)
  const list = [...byBatch.entries()].sort((a, b) => Number(BigInt(b[0].split("|")[0]) - BigInt(a[0].split("|")[0]))).slice(0, 20)
  return `
    <section class="section">
      <div class="section-title"><h2>Arkognito batches</h2><span class="faint">newest first</span></div>
      <div class="callout blue" style="margin-bottom:12px">${icon.info}<div>Each row is one relayer transaction. The order inside it is shuffled, every owner is new and sizes are padded, so nothing tells you which record came from whom. Open a record to see CREATE and TRANSFER in the same transaction.</div></div>
      <div class="card table-scroll">
        <table class="db"><thead><tr><th>Block</th><th>Relayer</th><th>Records</th><th>Owners (one each)</th><th>Sizes</th></tr></thead><tbody>
        ${list
          .map(([k, rs]) => {
            const [block, creator] = k.split("|")
            return `<tr>
              <td class="mono-cell">${Number(block).toLocaleString("en-US")}</td>
              <td class="mono-cell">${extLink(explorer.address(creator), short(creator))}</td>
              <td>${rs.length}</td>
              <td><div class="owner-chips">${rs.map((r) => `<span>${extLink(explorer.entity(r.key), short(r.owner, 3), "")}</span>`).join("")}</div></td>
              <td class="mono-cell">${[...new Set(rs.map((r) => r.size))].sort((a, b) => a - b).join(" · ")} B</td>
            </tr>`
          })
          .join("")}
        </tbody></table>
      </div>
    </section>`
}

export async function mountObserver(root: HTMLElement) {
  root.innerHTML = `
    <section class="card">
      <div class="card-head"><h2>Owner query</h2><span class="sub">the query anyone can run: <code>$owner = addr(…)</code></span></div>
      <div class="card-body">
        <form id="q" class="row"><input id="addr" placeholder="Paste a wallet address, 0x…" spellcheck="false" autocomplete="off" aria-label="Wallet address"><button class="primary">Run query</button></form>
        <div id="qout"></div>
      </div>
    </section>
    <div id="out" class="section"><div class="empty"><span class="spinner" style="display:inline-block;vertical-align:-2px;margin-right:8px"></span>Reading project <code>${PROJECT}</code> from Arkiv…</div></div>`
  const out = root.querySelector<HTMLElement>("#out")!

  root.querySelector<HTMLFormElement>("#q")!.onsubmit = async (ev) => {
    ev.preventDefault()
    const addr = root.querySelector<HTMLInputElement>("#addr")!.value.trim()
    const qout = root.querySelector<HTMLElement>("#qout")!
    if (!isAddress(addr)) return void (qout.innerHTML = `<p class="status err" style="margin-top:12px">Not an address.</p>`)
    qout.innerHTML = `<p class="status" style="margin-top:12px"><span class="spinner" style="margin-top:3px"></span><span>Querying Arkiv…</span></p>`
    try {
      const { entities } = await client.select({ key: true, creator: true }).where(eq("project", PROJECT)).ownedBy(addr).fetch()
      qout.innerHTML =
        `<p class="result-line"><strong>${entities.length}</strong> sketch${entities.length === 1 ? "" : "es"} owned by ${extLink(explorer.address(addr), short(addr), "ext mono")}.</p>` +
        `<div class="result-list">${entities
          .slice(0, 20)
          .map((e) => `<div>${extLink(explorer.entity(e.key), short(e.key, 6), "")} <span class="faint">created by ${short(e.creator)}</span></div>`)
          .join("")}</div>`
    } catch (e) {
      qout.innerHTML = `<p class="status err" style="margin-top:12px">${esc((e as Error).message)}</p>`
    }
  }

  let rows: Row[] = []
  try {
    rows = await load(PROJECT)
  } catch (e) {
    out.innerHTML = `<div class="empty" style="color:var(--err)">${esc((e as Error).message)}</div>`
    return
  }
  // A wallet that created its own sketch is the public Sketch App; a record created by someone else is Arkognito.
  const plain = rows.filter((r) => r.owner.toLowerCase() === r.creator.toLowerCase())
  const hidden = rows.filter((r) => r.owner.toLowerCase() !== r.creator.toLowerCase())
  out.innerHTML =
    `<div class="grid-2 even">` +
    summary("Without Arkognito", plain, "Public Sketch App: your wallet creates and owns each sketch.", false) +
    summary("With Arkognito", hidden, "Private Sketch App: a shared relayer creates each sketch and hands it to a one-time owner.", true) +
    `</div>` +
    batches(hidden)
}
