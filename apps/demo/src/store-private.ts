// The same Sketch App storage made private with Arkognito: 3 code lines differ from store-public.ts.
// Each sketch is owned by a fresh one-time address and created by the shared relayer, so an owner
// query on your wallet finds nothing, and myEntities() still finds all of yours.
import { createPublicClient, createWalletClient, ExpirationTime, jsonToPayload } from "@arkiv-network/sdk"
import { createPrivateClient } from "arkognito"
import { tiramisu } from "@arkiv-network/sdk/chains"
import { eq } from "@arkiv-network/sdk/query"
import { custom, http } from "viem"
import { PROJECT, connectWallet } from "./wallet"
import type { Sketch, SketchStore } from "./sketch-ui"

export async function openStore(): Promise<SketchStore> {
  const account = await connectWallet()
  const publicClient = createPublicClient({ chain: tiramisu, transport: http() })
  const arkiv = await createPrivateClient({ app: PROJECT, wallet: createWalletClient({ chain: tiramisu, transport: custom(window.ethereum!), account }) })
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
      (await arkiv.myEntities({ where: { type: "sketch" } })).map((e) => ({ key: e.key, ...(e.toJson() as Sketch) })),
  }
}
