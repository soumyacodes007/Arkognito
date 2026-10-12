// The Sketch App's storage, as Arkiv's MetaMask tutorial does it (ported to SDK 0.8 on Tiramisu).
// Every sketch is owned and created by your wallet, so one owner query lists all of them.
import { createPublicClient, createWalletClient, ExpirationTime, jsonToPayload } from "@arkiv-network/sdk"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { eq } from "@arkiv-network/sdk/query"
import { custom, http } from "viem"
import { PROJECT, connectWallet } from "./wallet"
import type { Sketch, SketchStore } from "./sketch-ui"

export async function openStore(): Promise<SketchStore> {
  const account = await connectWallet()
  const publicClient = createPublicClient({ chain: tiramisu, transport: http() })
  const arkiv = createWalletClient({ chain: tiramisu, transport: custom(window.ethereum!), account })
  return {
    account,
    save: (sketch: Sketch) =>
      arkiv.createEntity({
        payload: jsonToPayload(sketch),
        contentType: "application/json",
        attributes: { project: PROJECT, type: "sketch" },
        expires: ExpirationTime.fromDays(30),
      }),
    list: async () =>
      (await publicClient.select({ key: true, payload: true }).where(eq("project", PROJECT), eq("type", "sketch")).ownedBy(account).fetch()).entities.map((e) => ({ key: e.key, ...(e.toJson() as Sketch) })),
  }
}
