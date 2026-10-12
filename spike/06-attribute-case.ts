// Friction repro: are uppercase letters allowed in attribute names?
// SDK docs and the node's own error text say [A-Za-z0-9._-]; we saw "minBatch" rejected.
import { ExpirationTime, isValidAttributeName } from "@arkiv-network/sdk"
import { PROJECT, walletFor } from "./lib"

const w = walletFor("RELAYER_1_PRIVATE_KEY")
for (const name of ["minbatch", "minBatch", "Kind"]) {
  console.log(`SDK isValidAttributeName(${name}) = ${isValidAttributeName(name)}`)
  try {
    const { entityKey } = await w.createEntity({
      payload: new Uint8Array(),
      contentType: "application/octet-stream",
      attributes: { project: PROJECT, [name]: "x" },
      expires: ExpirationTime.fromMinutes(2),
    })
    console.log(`  node accepted ${name}: ${entityKey}`)
  } catch (e) {
    console.log(`  node rejected ${name}: ${(e as Error).message.slice(0, 200)}`)
  }
}
