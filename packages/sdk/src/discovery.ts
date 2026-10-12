// Relayer discovery from `arkognito.relayer` heartbeat entities (R8). A heartbeat's creator is the only
// address trusted for it, and a relayer is used only if its /v1/info reports that same address.
import { eq } from "@arkiv-network/sdk/query"
import type { Address, Hex } from "viem"
import { ARKOGNITO_PROJECT } from "./constants.ts"
import type { InfoResponse } from "./protocol.ts"
import type { ArkivReader } from "./reader.ts"

export type LiveRelayer = {
  url: string
  address: Address
  minBatch: number
  expiresAt: bigint
  tokensRequired: boolean
  /** Oblivious HTTP gateway key, when the relayer accepts requests through an OHTTP relay (R7). */
  ohttpKey?: Hex
}

export async function heartbeatRelayers(reader: ArkivReader): Promise<LiveRelayer[]> {
  const out: LiveRelayer[] = []
  const q = reader
    .select({ key: true, creator: true, attributes: true, expiresAt: true })
    .where(eq("project", ARKOGNITO_PROJECT), eq("type", "arkognito.relayer"))
    .limit(200)
    .atBlock(await reader.getBlockNumber())
  for await (const e of q) {
    out.push({
      url: String(e.attributes.url?.value ?? ""),
      address: e.creator,
      minBatch: Number(e.attributes.minbatch?.value ?? 0),
      expiresAt: e.expiresAt,
      tokensRequired: e.attributes.tokens?.value === true,
      ohttpKey: typeof e.attributes.ohttpkey?.value === "string" ? (e.attributes.ohttpkey.value as Hex) : undefined,
    })
  }
  return out
}

/** Live relayer URLs whose /v1/info address matches the heartbeat's creator. */
export async function discoverRelayers(reader: ArkivReader, fetchFn: typeof fetch = globalThis.fetch.bind(globalThis)) {
  const live = await heartbeatRelayers(reader)
  const ok: LiveRelayer[] = []
  await Promise.all(
    live.map(async (r) => {
      try {
        const info = (await (await fetchFn(`${r.url.replace(/\/$/, "")}/v1/info`)).json()) as InfoResponse
        if (info.address?.toLowerCase() === r.address.toLowerCase()) ok.push(r)
      } catch {
        // unreachable: skip
      }
    }),
  )
  return ok
}
