// `arkognito.relayer` heartbeat (R8): an expiring entity that doubles as discovery. If the relayer dies,
// the entity expires and it drops out on its own. Renewed through the same write queue as batches.
import { ExpirationTime, jsonToPayload } from "@arkiv-network/sdk"
import { bytes32, i32 } from "@arkiv-network/sdk/attr"
import { eq } from "@arkiv-network/sdk/query"
import { API_VERSION, ARKOGNITO_PROJECT } from "arkognito"
import type { Hex } from "viem"
import type { ArkivClients, WriteQueue } from "./arkiv"

export const HEARTBEAT_BLOCKS = 150

export class Heartbeat {
  key?: Hex
  lastBeat?: number
  #timer?: ReturnType<typeof setInterval>

  constructor(
    private arkiv: ArkivClients,
    private writer: WriteQueue,
    private info: { url: string; minBatch: number; tokensRequired: boolean; ohttpKey?: `0x${string}` },
    private log: (m: string) => void,
  ) {}

  async start(everyMs: number) {
    await this.beat()
    this.#timer = setInterval(() => void this.beat(), everyMs)
  }

  stop() {
    clearInterval(this.#timer)
  }

  async beat() {
    try {
      await this.writer.run(async () => {
        if (!this.key) {
          this.key = await this.#findExisting()
          // A heartbeat left by an earlier run may announce old settings or an old gateway key.
          if (this.key) await this.arkiv.walletClient.patchEntity({ entityKey: this.key, set: this.#settings() }).catch(() => undefined)
        }
        if (this.key) {
          try {
            await this.arkiv.walletClient.extendEntity({ entityKey: this.key, expires: ExpirationTime.fromBlocks(HEARTBEAT_BLOCKS) })
            this.lastBeat = Date.now()
            return
          } catch (e) {
            if (!/no entity|expired|not found/i.test((e as Error).message)) throw e
            this.key = undefined
          }
        }
        const { entityKey } = await this.arkiv.walletClient.createEntity({
          payload: jsonToPayload({ url: this.info.url, version: API_VERSION }),
          contentType: "application/json",
          attributes: { project: ARKOGNITO_PROJECT, type: "arkognito.relayer", url: this.info.url, ...this.#settings() },
          expires: ExpirationTime.fromBlocks(HEARTBEAT_BLOCKS),
        })
        this.key = entityKey
        this.lastBeat = Date.now()
        this.log(`heartbeat entity ${entityKey}`)
      })
    } catch (e) {
      this.log(`heartbeat failed: ${(e as Error).message.slice(0, 200)}`)
    }
  }

  #settings() {
    return {
      version: API_VERSION,
      minbatch: i32(this.info.minBatch),
      tokens: this.info.tokensRequired,
      // Clients take the OHTTP gateway key from here, never from a relay (R7).
      ...(this.info.ohttpKey ? { ohttpkey: bytes32(this.info.ohttpKey) } : {}),
    }
  }

  async #findExisting(): Promise<Hex | undefined> {
    const { entities } = await this.arkiv.publicClient
      .select({ key: true })
      .where(eq("project", ARKOGNITO_PROJECT), eq("type", "arkognito.relayer"), eq("url", this.info.url))
      .createdBy(this.arkiv.address)
      .limit(1)
      .fetch()
    return entities[0]?.key
  }
}

