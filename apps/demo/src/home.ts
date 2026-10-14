// Overview page: what Arkognito does, the demo pages, and the relayers live on Tiramisu right now.
import { heartbeatRelayers } from "arkognito"
import type { ArkivReader } from "arkognito"
import { eq } from "@arkiv-network/sdk/query"
import { esc, explorer, extLink, icon, reader, short } from "./layout"
import { PROJECT } from "./wallet"

const DOCS = "https://github.com/soumyacodes007/Arkognito#readme"

export async function mountHome(root: HTMLElement) {
  root.innerHTML = `
    <section class="hero hero-grid">
      <div>
      <span class="eyebrow"><span class="tag blue">Live</span> Running on Arkiv Tiramisu testnet</span>
      <h1>Private ownership for Arkiv.</h1>
      <p class="lede">Your records stay yours, and you can still find and prove them. But nobody reading Arkiv can tell which records belong to the same person.</p>
      <div class="row">
        <a class="btn primary" href="/sketch-private.html">Try the private app</a>
        <a class="btn" href="/observer.html">See what an observer sees</a>
        <a class="btn" href="${DOCS}" target="_blank" rel="noopener" style="border-color:transparent">Docs ${icon.ext}</a>
      </div>
      </div>
      <aside class="card tx-card" id="batch" aria-live="polite">
        <div class="card-head"><span class="dot live"></span><h2>Recent private batch</h2><span class="sub" id="batch-sub">reading Arkiv…</span></div>
        <div class="card-body" id="batch-body"><div class="faint" style="font-size:14px">Loading…</div></div>
      </aside>
    </section>

    <section class="section" style="margin-top:24px">
      <div class="callout">${icon.info}<div><strong>The problem.</strong> On Arkiv, <code>$owner = addr(&lt;your wallet&gt;)</code> lists everything a wallet has ever written, in every app. One query links all of it to you.</div></div>
    </section>

    <section class="section">
      <div class="section-title"><h2>How it works</h2></div>
      <div class="how">
        <div><span class="n">01</span><h3>One signature</h3><p>Your wallet signs one message. Your keys are derived from it inside a Web Worker.</p></div>
        <div><span class="n">02</span><h3>One owner per record</h3><p>Each record gets a fresh one-time owner. Only you can find it again, from any device.</p></div>
        <div><span class="n">03</span><h3>Shared relayers</h3><p>Relayers write records in shuffled, padded batches and pay the gas.</p></div>
        <div><span class="n">04</span><h3>Blind tokens</h3><p>Rate limits without knowing who wrote what. Optional Oblivious HTTP hides your IP.</p></div>
      </div>
    </section>

    <section class="section">
      <div class="section-title"><h2>Demo</h2><span class="faint">4 pages</span></div>
      <div class="card table-scroll">
        <table class="db">
          <thead><tr><th>Page</th><th>Owner of each record</th><th>Wallet prompts</th><th>Gas</th></tr></thead>
          <tbody>
            <tr><td class="title-cell"><a href="/sketch-public.html">${icon.eye}Sketch App, public</a></td><td><span class="tag err">Your wallet</span></td><td>1 transaction per save</td><td>You</td></tr>
            <tr><td class="title-cell"><a href="/sketch-private.html">${icon.lock}Sketch App, private</a></td><td><span class="tag ok">One-time address</span></td><td>1 signature at connect</td><td>Relayer</td></tr>
            <tr><td class="title-cell"><a href="/observer.html">${icon.layers}Observer view</a></td><td colspan="3" class="muted">What anyone reading Arkiv sees, before and after</td></tr>
            <tr><td class="title-cell"><a href="/determinism.html">${icon.key}Wallet check</a></td><td colspan="3" class="muted">Does your wallet sign the key message the same way twice?</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="section">
      <div class="section-title"><h2>Relayers live now</h2><span class="faint">from their heartbeat entities on Arkiv</span></div>
      <div class="card table-scroll" id="relayers"><div class="card-body muted"><span class="spinner" style="display:inline-block;vertical-align:-2px;margin-right:8px"></span>Reading heartbeats…</div></div>
    </section>`

  void latestBatch(root)
  const box = root.querySelector<HTMLElement>("#relayers")!
  try {
    const live = await heartbeatRelayers(reader as unknown as ArkivReader)
    if (live.length === 0) {
      box.innerHTML = `<div class="card-body muted">No relayer heartbeat on Arkiv right now.</div>`
      return
    }
    const head = await reader.getBlockNumber()
    box.innerHTML = `
      <table class="db">
        <thead><tr><th>Relayer</th><th>Address</th><th>Min batch</th><th>Tokens</th><th>OHTTP</th><th>Heartbeat</th></tr></thead>
        <tbody>${live
          .map(
            (r) => `<tr>
              <td class="mono-cell">${esc(r.url.replace(/^https?:\/\//, ""))}</td>
              <td class="mono-cell">${extLink(explorer.address(r.address), short(r.address))}</td>
              <td>${r.minBatch}</td>
              <td>${r.tokensRequired ? `<span class="tag">Required</span>` : `<span class="tag">Off</span>`}</td>
              <td>${r.ohttpKey ? `<span class="tag ok">Yes</span>` : `<span class="tag">No</span>`}</td>
              <td><span class="row" style="gap:8px"><span class="dot live"></span><span class="muted">${Math.max(0, Number(r.expiresAt - head) * 2)} s left</span></span></td>
            </tr>`,
          )
          .join("")}</tbody>
      </table>`
  } catch (e) {
    box.innerHTML = `<div class="card-body" style="color:var(--err)">${esc((e as Error).message)}</div>`
  }
}

/** The newest relayer batch in the demo project, as an explorer would show its operations. */
async function latestBatch(root: HTMLElement) {
  const body = root.querySelector<HTMLElement>("#batch-body")!
  const sub = root.querySelector<HTMLElement>("#batch-sub")!
  try {
    const rows: { key: string; owner: string; creator: string; createdAt: bigint; size: number }[] = []
    for await (const e of reader
      .select({ key: true, owner: true, creator: true, createdAt: true, payload: true })
      .where(eq("project", PROJECT))
      .limit(200)) {
      if (e.owner.toLowerCase() !== e.creator.toLowerCase()) rows.push({ key: e.key, owner: e.owner, creator: e.creator, createdAt: e.createdAt, size: e.payload.length })
      if (rows.length >= 1000) break
    }
    if (rows.length === 0) {
      sub.textContent = "none yet"
      body.innerHTML = `<div class="faint" style="font-size:14px">Save a sketch in the private app to see one here.</div>`
      return
    }
    // One transaction = one (block, relayer). Show the newest batch that actually mixes people.
    const groups = new Map<string, typeof rows>()
    for (const r of rows) {
      const k = `${r.createdAt}|${r.creator.toLowerCase()}`
      groups.set(k, [...(groups.get(k) ?? []), r])
    }
    const byNewest = [...groups.values()].sort((a, b) => (b[0].createdAt > a[0].createdAt ? 1 : -1))
    const batch = byNewest.find((g) => g.length >= 3) ?? byNewest[0]
    const newest = batch[0]
    sub.innerHTML = `block ${Number(newest.createdAt).toLocaleString("en-US")} · ${batch.length} record${batch.length === 1 ? "" : "s"}`
    body.innerHTML = `
      <div class="tx-from"><span class="faint">From</span> ${extLink(explorer.address(newest.creator), short(newest.creator), "ext mono")} <span class="tag">relayer</span></div>
      <ol class="ops">${batch
        .map(
          (r, i) => `<li><span class="op">CREATE</span><span class="mono">${extLink(explorer.entity(r.key), short(r.key, 5), "")}</span><span class="faint mono">${r.size} B</span></li>
             <li class="sub-op"><span class="op transfer">TRANSFER</span><span class="faint">to</span><span class="mono">${short(r.owner)}</span><span class="tag ok">new owner ${i + 1}</span></li>`,
        )
        .join("")}</ol>
      <div class="tx-foot faint">Same block, same relayer, a different first-time owner for every record.</div>`
  } catch (e) {
    sub.textContent = "unavailable"
    body.innerHTML = `<div style="color:var(--err);font-size:14px">${esc((e as Error).message)}</div>`
  }
}
