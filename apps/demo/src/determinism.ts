// Spike test 4 / edge case K1: does this wallet sign the Arkognito key message the same way twice?
import { createWalletClient, custom } from "viem"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { KeyVault, derivationTypedData, scopeRef } from "arkognito"
import { esc, icon } from "./layout"
import { connectWallet } from "./wallet"

export function mountDeterminism(root: HTMLElement) {
  root.innerHTML = `
    <section class="card" style="max-width:760px">
      <div class="card-body stack">
        <div class="callout">${icon.info}<div>MetaMask will ask you to sign the same message twice. Nothing is sent anywhere and nothing is written to Arkiv. In the apps, Arkognito does this check once per device and remembers the result.</div></div>
        <ol class="steps" id="steps"></ol>
      </div>
      <div class="card-foot"><button id="go" class="primary">Run the check</button><p id="out" class="status" role="status"></p></div>
    </section>`
  const out = root.querySelector<HTMLElement>("#out")!
  const stepsEl = root.querySelector<HTMLElement>("#steps")!
  const steps = [
    { title: "First signature", state: "todo", detail: "" },
    { title: "Second signature", state: "todo", detail: "" },
    { title: "Compare", state: "todo", detail: "" },
  ]
  const render = () =>
    (stepsEl.innerHTML = steps.map((s) => `<li class="${s.state}"><span class="st"></span><div><div>${s.title}</div><div class="detail">${s.detail}</div></div><span></span></li>`).join(""))
  render()
  root.querySelector<HTMLButtonElement>("#go")!.onclick = async () => {
    for (const s of steps) Object.assign(s, { state: "todo", detail: "" })
    out.className = "status"
    out.textContent = ""
    try {
      const account = await connectWallet()
      const wallet = createWalletClient({ chain: tiramisu, transport: custom(window.ethereum!), account })
      const typed = derivationTypedData("arkognito-demo-sketch")
      steps[0].state = "active"
      render()
      const a = await wallet.signTypedData(typed)
      Object.assign(steps[0], { state: "done", detail: `<span class="mono">${a.slice(0, 22)}…</span>` })
      steps[1].state = "active"
      render()
      const b = await wallet.signTypedData(typed)
      Object.assign(steps[1], { state: "done", detail: `<span class="mono">${b.slice(0, 22)}…</span>` })
      const same = a.toLowerCase() === b.toLowerCase()
      const first = await KeyVault.fromSignature(a, "arkognito-demo-sketch").addressOf(scopeRef("demo"))
      Object.assign(steps[2], {
        state: same ? "done" : "fail",
        detail: same
          ? `Identical. This wallet re-derives the same keys every time. A scope address derived from it: <span class="mono">${first}</span>`
          : "The two signatures differ. Arkognito would refuse signature mode for this wallet and offer a random key with a recovery code.",
      })
      render()
      out.className = `status ${same ? "ok" : "err"}`
      out.textContent = same ? "Pass" : "Fail"
    } catch (e) {
      const i = steps.findIndex((s) => s.state === "active")
      if (i >= 0) Object.assign(steps[i], { state: "fail", detail: esc((e as Error).message) })
      render()
      out.className = "status err"
      out.textContent = (e as Error).message
    }
  }
}
