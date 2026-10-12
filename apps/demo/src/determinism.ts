// Spike test 4 / edge case K1: does this wallet sign the Arkognito key message the same way twice?
import { createWalletClient, custom } from "viem"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { KeyVault, derivationTypedData, scopeRef } from "arkognito"
import { connectWallet } from "./wallet"

export function mountDeterminism(root: HTMLElement) {
  root.innerHTML = `
    <section class="card">
      <p>MetaMask will ask you to sign the same message twice. Nothing is sent anywhere and nothing is written to Arkiv.</p>
      <button id="go" class="primary">Run the check</button>
      <p id="out" class="status" role="status"></p>
    </section>`
  const out = root.querySelector<HTMLElement>("#out")!
  root.querySelector<HTMLButtonElement>("#go")!.onclick = async () => {
    try {
      const account = await connectWallet()
      const wallet = createWalletClient({ chain: tiramisu, transport: custom(window.ethereum!), account })
      const typed = derivationTypedData("arkognito-demo-sketch")
      out.textContent = "Sign the first time…"
      const a = await wallet.signTypedData(typed)
      out.textContent = "Sign the second time…"
      const b = await wallet.signTypedData(typed)
      const same = a.toLowerCase() === b.toLowerCase()
      const first = await KeyVault.fromSignature(a, "arkognito-demo-sketch").addressOf(scopeRef("demo"))
      out.className = `status ${same ? "ok" : "err"}`
      out.textContent = same
        ? `PASS: both signatures are identical, so this wallet re-derives the same Arkognito keys every time. A scope address derived from it: ${first}.`
        : "FAIL: the two signatures differ. Arkognito would refuse signature mode for this wallet and offer a random key with a recovery code (K1)."
    } catch (e) {
      out.className = "status err"
      out.textContent = (e as Error).message
    }
  }
}
